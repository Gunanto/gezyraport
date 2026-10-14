import { Hono } from "hono";
import { db } from "../db";
import { requireRole } from "../auth";
import { periodeAktif, parseCSV, csvField } from "../util";

/**
 * Fase 2 — input catatan raport + kehadiran.
 * Semua endpoint memakai periode aktif (semester + tahun ajaran dari desain_raport).
 * Admin punya akses penuh (baca + tulis); guru hanya sesuai perannya.
 */
const catatan = new Hono();
catatan.use(requireRole("guru", "admin"));

interface GuruInfo {
  gid: number;
  is_bk: boolean;
  is_ekskul: boolean;
}

function infoGuru(c: any): GuruInfo | null {
  const u = c.get("user") as any;
  if (u.role === "admin") return null; // admin = akses penuh, tanpa info guru
  const g = db
    .query("SELECT id, is_bk, is_ekskul FROM guru WHERE user_id = ?")
    .get(u.id) as any;
  if (!g) return null;
  return { gid: Number(g.id), is_bk: !!g.is_bk, is_ekskul: !!g.is_ekskul };
}

function isWali(gid: number, kelas_id: any): boolean {
  return !!db
    .query("SELECT 1 FROM kelas WHERE id = ? AND wali_guru_id = ?")
    .get(kelas_id, gid);
}

function cekAjar(gid: number, mapel_id: any, kelas_id: any): boolean {
  return !!db
    .query(
      "SELECT 1 FROM guru_mapel WHERE guru_id = ? AND mapel_id = ? AND kelas_id = ?"
    )
    .get(gid, mapel_id, kelas_id);
}

/** Kelas-kelas yang ditangani seorang guru BK (untuk Catatan BK). */
function cekBK(gid: number, kelas_id: any): boolean {
  return !!db
    .query("SELECT 1 FROM bk_kelas WHERE guru_id = ? AND kelas_id = ?")
    .get(gid, kelas_id);
}

function kelasAda(kelas_id: any): boolean {
  return !!db.query("SELECT 1 FROM kelas WHERE id = ?").get(kelas_id);
}

/** Daftar kelas (untuk pemilih kelas di halaman BK/ekskul).
 *  Guru BK hanya melihat kelas yang ditanganinya (?fitur=bk). */
catatan.get("/kelas", (c) => {
  const gi = infoGuru(c);
  const rows =
    gi && gi.is_bk && c.req.query("fitur") === "bk"
      ? db
          .query(
            `SELECT k.id, k.nama, k.tingkat FROM bk_kelas b
             JOIN kelas k ON k.id = b.kelas_id
             WHERE b.guru_id = ? ORDER BY k.tingkat, k.nama`
          )
          .all(gi.gid)
      : db
          .query("SELECT id, nama, tingkat FROM kelas ORDER BY tingkat, nama")
          .all();
  return c.json({ kelas: rows });
});

/** Siswa satu kelas beserta catatan_raport periode aktif (kolom dinamis). */
function siswaDenganCatatan(kelas_id: any, kolom: string[]) {
  const p = periodeAktif();
  return db
    .query(
      `SELECT s.id AS siswa_id, s.nis, s.nama, ${kolom
        .map((k) => `c.${k}`)
        .join(", ")}
       FROM siswa s
       LEFT JOIN catatan_raport c
         ON c.siswa_id = s.id AND c.tahun_ajaran = ? AND c.semester = ?
       WHERE s.kelas_id = ? ORDER BY s.nama`
    )
    .all(p.tahun_ajaran, p.semester, kelas_id);
}

/**
 * Upsert catatan_raport. `patch` = {kolom: nilai} — kolom sudah di-whitelist
 * per endpoint pemanggil. Teks kosong disimpan sebagai NULL.
 */
function upsertCatatan(
  siswa_id: number,
  patch: Record<string, string | number | null>
) {
  const p = periodeAktif();
  const cols = Object.keys(patch);
  const vals = cols.map((k) => {
    const v = patch[k];
    if (typeof v === "string") {
      const t = v.trim();
      return t === "" ? null : t;
    }
    return v;
  });
  db.query(
    `INSERT INTO catatan_raport (siswa_id, tahun_ajaran, semester, ${cols.join(", ")})
     VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})
     ON CONFLICT(siswa_id, tahun_ajaran, semester)
     DO UPDATE SET ${cols.map((k) => `${k} = excluded.${k}`).join(", ")}`
  ).run(siswa_id, p.tahun_ajaran, p.semester, ...vals);
}

/** Pastikan siswa_id memang siswa kelas_id; kembalikan nama atau null. */
function cekSiswaKelas(siswa_id: any, kelas_id: any): string | null {
  const sw = db
    .query("SELECT nama FROM siswa WHERE id = ? AND kelas_id = ?")
    .get(siswa_id, kelas_id) as any;
  return sw ? sw.nama : null;
}

function validHadir(v: any): number | null {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/* ================= WALI KELAS ================= */
/* catatan_wali + sakit/izin/alpa. Guard: wali kelas tsb (admin: penuh). */

catatan.get("/wali", (c) => {
  const kelas_id = c.req.query("kelas_id");
  if (!kelas_id || !kelasAda(kelas_id))
    return c.json({ error: "kelas_id tidak valid" }, 400);
  const gi = infoGuru(c);
  if (gi && !isWali(gi.gid, kelas_id))
    return c.json({ error: "Anda bukan wali kelas ini" }, 403);
  return c.json({
    siswa: siswaDenganCatatan(kelas_id, ["catatan_wali", "sakit", "izin", "alpa"]),
    periode: periodeAktif(),
  });
});

catatan.put("/wali", async (c) => {
  const gi = infoGuru(c);
  const { kelas_id, rows } = await c.req.json();
  if (!kelas_id || !kelasAda(kelas_id) || !Array.isArray(rows))
    return c.json({ error: "kelas_id dan rows wajib diisi" }, 400);
  if (gi && !isWali(gi.gid, kelas_id))
    return c.json({ error: "Anda bukan wali kelas ini" }, 403);
  let tersimpan = 0;
  const gagal: string[] = [];
  const simpan = db.transaction(() => {
    for (const r of rows) {
      const nama = cekSiswaKelas(r.siswa_id, kelas_id);
      if (!nama) {
        gagal.push(`Siswa ID ${r.siswa_id}: bukan siswa kelas ini`);
        continue;
      }
      const sakit = validHadir(r.sakit);
      const izin = validHadir(r.izin);
      const alpa = validHadir(r.alpa);
      if (sakit === null || izin === null || alpa === null) {
        gagal.push(`${nama}: kehadiran harus angka bulat ≥ 0`);
        continue;
      }
      upsertCatatan(Number(r.siswa_id), {
        catatan_wali: r.catatan_wali ?? null,
        sakit,
        izin,
        alpa,
      });
      tersimpan++;
    }
  });
  simpan();
  return c.json({ ok: true, tersimpan, gagal });
});

/* ================= BK ================= */
/* catatan_bk untuk semua kelas. Guard: guru is_bk=1 (admin: penuh). */

catatan.get("/bk", (c) => {
  const kelas_id = c.req.query("kelas_id");
  if (!kelas_id || !kelasAda(kelas_id))
    return c.json({ error: "kelas_id tidak valid" }, 400);
  const gi = infoGuru(c);
  if (gi && !gi.is_bk)
    return c.json({ error: "Halaman ini khusus guru BK" }, 403);
  if (gi && !cekBK(gi.gid, kelas_id))
    return c.json({ error: "Anda bukan guru BK kelas ini" }, 403);
  return c.json({
    siswa: siswaDenganCatatan(kelas_id, ["catatan_bk"]),
    periode: periodeAktif(),
  });
});

catatan.put("/bk", async (c) => {
  const gi = infoGuru(c);
  if (gi && !gi.is_bk)
    return c.json({ error: "Halaman ini khusus guru BK" }, 403);
  const { kelas_id, rows } = await c.req.json();
  if (!kelas_id || !kelasAda(kelas_id) || !Array.isArray(rows))
    return c.json({ error: "kelas_id dan rows wajib diisi" }, 400);
  if (gi && !cekBK(gi.gid, kelas_id))
    return c.json({ error: "Anda bukan guru BK kelas ini" }, 403);
  let tersimpan = 0;
  const gagal: string[] = [];
  const simpan = db.transaction(() => {
    for (const r of rows) {
      const nama = cekSiswaKelas(r.siswa_id, kelas_id);
      if (!nama) {
        gagal.push(`Siswa ID ${r.siswa_id}: bukan siswa kelas ini`);
        continue;
      }
      upsertCatatan(Number(r.siswa_id), { catatan_bk: r.catatan_bk ?? null });
      tersimpan++;
    }
  });
  simpan();
  return c.json({ ok: true, tersimpan, gagal });
});

/* ================= EKSKUL ================= */
/* catatan_ekskul untuk semua kelas. Guard: guru is_ekskul=1 (admin: penuh). */

catatan.get("/ekskul", (c) => {
  const kelas_id = c.req.query("kelas_id");
  if (!kelas_id || !kelasAda(kelas_id))
    return c.json({ error: "kelas_id tidak valid" }, 400);
  const gi = infoGuru(c);
  if (gi && !gi.is_ekskul)
    return c.json({ error: "Halaman ini khusus pembina ekskul" }, 403);
  return c.json({
    siswa: siswaDenganCatatan(kelas_id, ["catatan_ekskul"]),
    periode: periodeAktif(),
  });
});

catatan.put("/ekskul", async (c) => {
  const gi = infoGuru(c);
  if (gi && !gi.is_ekskul)
    return c.json({ error: "Halaman ini khusus pembina ekskul" }, 403);
  const { kelas_id, rows } = await c.req.json();
  if (!kelas_id || !kelasAda(kelas_id) || !Array.isArray(rows))
    return c.json({ error: "kelas_id dan rows wajib diisi" }, 400);
  let tersimpan = 0;
  const gagal: string[] = [];
  const simpan = db.transaction(() => {
    for (const r of rows) {
      const nama = cekSiswaKelas(r.siswa_id, kelas_id);
      if (!nama) {
        gagal.push(`Siswa ID ${r.siswa_id}: bukan siswa kelas ini`);
        continue;
      }
      upsertCatatan(Number(r.siswa_id), {
        catatan_ekskul: r.catatan_ekskul ?? null,
      });
      tersimpan++;
    }
  });
  simpan();
  return c.json({ ok: true, tersimpan, gagal });
});

/* ================= CATATAN GURU MAPEL ================= */
/* catatan_guru per kelas+mapel. Guard: guru mengajar mapel itu di kelas itu. */

catatan.get("/guru", (c) => {
  const kelas_id = c.req.query("kelas_id");
  const mapel_id = c.req.query("mapel_id");
  if (!kelas_id || !mapel_id || !kelasAda(kelas_id))
    return c.json({ error: "kelas_id dan mapel_id wajib diisi" }, 400);
  const gi = infoGuru(c);
  if (gi && !cekAjar(gi.gid, mapel_id, kelas_id))
    return c.json({ error: "Anda tidak mengajar mapel ini di kelas ini" }, 403);
  return c.json({
    siswa: siswaDenganCatatan(kelas_id, ["catatan_guru"]),
    periode: periodeAktif(),
  });
});

catatan.put("/guru", async (c) => {
  const gi = infoGuru(c);
  const { kelas_id, mapel_id, rows } = await c.req.json();
  if (!kelas_id || !mapel_id || !kelasAda(kelas_id) || !Array.isArray(rows))
    return c.json({ error: "kelas_id, mapel_id, dan rows wajib diisi" }, 400);
  if (gi && !cekAjar(gi.gid, mapel_id, kelas_id))
    return c.json({ error: "Anda tidak mengajar mapel ini di kelas ini" }, 403);
  let tersimpan = 0;
  const gagal: string[] = [];
  const simpan = db.transaction(() => {
    for (const r of rows) {
      const nama = cekSiswaKelas(r.siswa_id, kelas_id);
      if (!nama) {
        gagal.push(`Siswa ID ${r.siswa_id}: bukan siswa kelas ini`);
        continue;
      }
      upsertCatatan(Number(r.siswa_id), {
        catatan_guru: r.catatan_guru ?? null,
      });
      tersimpan++;
    }
  });
  simpan();
  return c.json({ ok: true, tersimpan, gagal });
});

/* ================= TEMPLATE & IMPORT CSV ================= */
/* Kolom nis & nama hanya referensi baca manusia; pencocokan via nis.
   Hanya kolom milik fitur itu yang diupdate; kolom lain tidak tersentuh.
   Teks kosong = hapus catatan (NULL); angka kosong = pertahankan nilai lama. */

interface FiturCatatan {
  kolom: string[];
  csv: string[];
  perluMapel: boolean;
  cek: (gi: GuruInfo | null, kelas_id: any, mapel_id?: any) => string | null;
}

const FITUR: Record<string, FiturCatatan> = {
  wali: {
    kolom: ["catatan_wali", "sakit", "izin", "alpa"],
    csv: ["nis", "nama", "catatan_wali", "sakit", "izin", "alpa"],
    perluMapel: false,
    cek: (gi, kelas_id) =>
      gi && !isWali(gi.gid, kelas_id) ? "Anda bukan wali kelas ini" : null,
  },
  bk: {
    kolom: ["catatan_bk"],
    csv: ["nis", "nama", "catatan_bk"],
    perluMapel: false,
    cek: (gi, kelas_id) =>
      gi && !gi.is_bk
        ? "Halaman ini khusus guru BK"
        : gi && !cekBK(gi.gid, kelas_id)
          ? "Anda bukan guru BK kelas ini"
          : null,
  },
  ekskul: {
    kolom: ["catatan_ekskul"],
    csv: ["nis", "nama", "catatan_ekskul"],
    perluMapel: false,
    cek: (gi) =>
      gi && !gi.is_ekskul ? "Halaman ini khusus pembina ekskul" : null,
  },
  guru: {
    kolom: ["catatan_guru"],
    csv: ["nis", "nama", "catatan_guru"],
    perluMapel: true,
    cek: (gi, kelas_id, mapel_id) =>
      gi && !cekAjar(gi.gid, mapel_id, kelas_id)
        ? "Anda tidak mengajar mapel ini di kelas ini"
        : null,
  },
};

const KOLOM_ANGKA = new Set(["sakit", "izin", "alpa"]);

function namaKelas(kelas_id: any): string {
  const k = db.query("SELECT nama FROM kelas WHERE id = ?").get(kelas_id) as any;
  return k?.nama ?? "kelas";
}

/** Unduh template CSV (terisi data yang sudah tersimpan — sekaligus export). */
catatan.get("/:fitur/template", (c) => {
  const key = c.req.param("fitur");
  const f = FITUR[key];
  if (!f) return c.json({ error: "Fitur tidak dikenal" }, 404);
  const kelas_id = c.req.query("kelas_id");
  const mapel_id = c.req.query("mapel_id");
  if (!kelas_id || !kelasAda(kelas_id))
    return c.json({ error: "kelas_id tidak valid" }, 400);
  if (f.perluMapel && !mapel_id)
    return c.json({ error: "mapel_id wajib diisi" }, 400);
  const err = f.cek(infoGuru(c), kelas_id, mapel_id);
  if (err) return c.json({ error: err }, 403);
  const rows = siswaDenganCatatan(kelas_id, f.kolom) as any[];
  const lines = [f.csv.join(",")];
  for (const r of rows) {
    const vals = f.csv.map((col) => {
      if (col === "nis") return r.nis;
      if (col === "nama") return r.nama;
      if (KOLOM_ANGKA.has(col)) return r[col] ?? 0;
      return r[col] ?? "";
    });
    lines.push(vals.map(csvField).join(","));
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="template-${key}-${namaKelas(kelas_id)}.csv"`
  );
  return c.body("\uFEFF" + lines.join("\n"));
});

/** Import CSV: cocokkan via nis dalam kelas yang dipilih. */
catatan.post("/:fitur/import", async (c) => {
  const key = c.req.param("fitur");
  const f = FITUR[key];
  if (!f) return c.json({ error: "Fitur tidak dikenal" }, 404);
  const kelas_id = c.req.query("kelas_id");
  const mapel_id = c.req.query("mapel_id");
  if (!kelas_id || !kelasAda(kelas_id))
    return c.json({ error: "kelas_id tidak valid" }, 400);
  if (f.perluMapel && !mapel_id)
    return c.json({ error: "mapel_id wajib diisi" }, 400);
  const err = f.cek(infoGuru(c), kelas_id, mapel_id);
  if (err) return c.json({ error: err }, 403);
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string")
    return c.json({ error: "File CSV tidak ditemukan" }, 400);
  const rows = parseCSV(await (file as File).text());
  if (!rows.length) return c.json({ error: "File kosong" }, 400);
  let start = 0;
  if (/nis/i.test(rows[0][0] ?? "")) start = 1;
  let sukses = 0;
  const gagal: Array<{ baris: number; alasan: string }> = [];
  const simpan = db.transaction(() => {
    for (let i = start; i < rows.length; i++) {
      const no = i + 1;
      const cells = rows[i].map((x) => (x ?? "").trim());
      const nis = cells[0] || "";
      if (!nis) {
        gagal.push({ baris: no, alasan: "NIS kosong" });
        continue;
      }
      const sw = db
        .query("SELECT id FROM siswa WHERE nis = ? AND kelas_id = ?")
        .get(nis, kelas_id) as any;
      if (!sw) {
        gagal.push({ baris: no, alasan: `NIS "${nis}" bukan siswa kelas ini` });
        continue;
      }
      const patch: Record<string, string | number | null> = {};
      let barisOk = true;
      f.csv.forEach((col, idx) => {
        if (idx < 2 || !barisOk) return; // nis & nama hanya referensi
        const raw = cells[idx] ?? "";
        if (KOLOM_ANGKA.has(col)) {
          if (raw === "") return; // kosong = pertahankan nilai lama
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 0) {
            gagal.push({ baris: no, alasan: `${col} harus angka bulat ≥ 0` });
            barisOk = false;
          } else {
            patch[col] = n;
          }
        } else {
          patch[col] = raw; // kosong = hapus catatan
        }
      });
      if (!barisOk) continue;
      upsertCatatan(Number(sw.id), patch);
      sukses++;
    }
  });
  simpan();
  return c.json({ ok: true, sukses, gagal });
});

export default catatan;
