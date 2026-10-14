import { Hono } from "hono";
import { db } from "../db";
import { requireRole } from "../auth";
import { parseCSV, csvField, periodeAktif, DEFAULT_RENTANG } from "../util";

const guru = new Hono();
guru.use(requireRole("guru"));

function guruId(c: any): number | null {
  const u = c.get("user");
  const g = db.query("SELECT id FROM guru WHERE user_id = ?").get(u.id) as any;
  return g ? Number(g.id) : null;
}

function ajarGuru(gid: number) {
  return db
    .query(
      `SELECT gm.mapel_id, m.nama AS mapel_nama, m.kode AS mapel_kode,
              gm.kelas_id, k.nama AS kelas_nama
       FROM guru_mapel gm
       JOIN mapel m ON m.id = gm.mapel_id
       JOIN kelas k ON k.id = gm.kelas_id
       WHERE gm.guru_id = ? ORDER BY k.nama, m.urutan`
    )
    .all(gid) as any[];
}

/** Daftar pasangan mapel+kelas yang diajar guru ini. */
guru.get("/ajar", (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  return c.json({ ajar: ajarGuru(gid) });
});

/** Kelas-kelas yang diajar guru ini (unik). */
guru.get("/kelas", (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const rows = db
    .query(
      `SELECT DISTINCT k.id, k.nama, k.tingkat
       FROM guru_mapel gm JOIN kelas k ON k.id = gm.kelas_id
       WHERE gm.guru_id = ? ORDER BY k.nama`
    )
    .all(gid);
  return c.json({ kelas: rows });
});

/** Mapel-mapel yang diajar guru ini (unik). */
guru.get("/mapel", (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const rows = db
    .query(
      `SELECT DISTINCT m.id, m.nama, m.kode
       FROM guru_mapel gm JOIN mapel m ON m.id = gm.mapel_id
       WHERE gm.guru_id = ? ORDER BY m.urutan`
    )
    .all(gid);
  return c.json({ mapel: rows });
});

function cekAjar(gid: number, mapel_id: any, kelas_id?: any): boolean {
  let sql = "SELECT 1 FROM guru_mapel WHERE guru_id = ? AND mapel_id = ?";
  const p: any[] = [gid, mapel_id];
  if (kelas_id) {
    sql += " AND kelas_id = ?";
    p.push(kelas_id);
  }
  return !!db.query(sql).get(...p);
}

/* ---------- Rentang nilai ---------- */

guru.get("/rentang", (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const mapel_id = c.req.query("mapel_id");
  if (!mapel_id) return c.json({ error: "mapel_id wajib diisi" }, 400);
  const rows = db
    .query(
      "SELECT label, min_nilai, max_nilai FROM rentang_nilai WHERE mapel_id = ? AND guru_id = ? ORDER BY min_nilai DESC"
    )
    .all(mapel_id, gid);
  if (!rows.length) return c.json({ rentang: DEFAULT_RENTANG, isDefault: true });
  return c.json({ rentang: rows, isDefault: false });
});

guru.put("/rentang", async (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const { mapel_id, rentang } = await c.req.json();
  if (!mapel_id || !Array.isArray(rentang) || !rentang.length)
    return c.json({ error: "mapel_id dan rentang wajib diisi" }, 400);
  if (!cekAjar(gid, mapel_id))
    return c.json({ error: "Anda tidak mengajar mapel ini" }, 403);
  for (const r of rentang) {
    if (
      !r.label ||
      typeof r.min_nilai !== "number" ||
      typeof r.max_nilai !== "number" ||
      r.min_nilai > r.max_nilai ||
      r.min_nilai < 0 ||
      r.max_nilai > 100
    )
      return c.json(
        { error: `Rentang "${r.label || "-"}" tidak valid (0–100, min ≤ max)` },
        400
      );
  }
  const simpan = db.transaction(() => {
    db.query("DELETE FROM rentang_nilai WHERE mapel_id = ? AND guru_id = ?").run(
      mapel_id,
      gid
    );
    const ins = db.query(
      "INSERT INTO rentang_nilai (mapel_id, guru_id, label, min_nilai, max_nilai) VALUES (?,?,?,?,?)"
    );
    for (const r of rentang) ins.run(mapel_id, gid, r.label, r.min_nilai, r.max_nilai);
  });
  simpan();
  return c.json({ ok: true });
});

/* ---------- Nilai ---------- */

guru.get("/nilai", (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const kelas_id = c.req.query("kelas_id");
  const mapel_id = c.req.query("mapel_id");
  if (!kelas_id || !mapel_id)
    return c.json({ error: "kelas_id dan mapel_id wajib diisi" }, 400);
  if (!cekAjar(gid, mapel_id, kelas_id))
    return c.json({ error: "Anda tidak mengajar mapel ini di kelas ini" }, 403);
  const p = periodeAktif();
  const rows = db
    .query(
      `SELECT s.id AS siswa_id, s.nis, s.nama, n.nilai_angka
       FROM siswa s
       LEFT JOIN nilai n ON n.siswa_id = s.id AND n.mapel_id = ?
         AND n.tahun_ajaran = ? AND n.semester = ?
       WHERE s.kelas_id = ? ORDER BY s.nama`
    )
    .all(mapel_id, p.tahun_ajaran, p.semester, kelas_id);
  return c.json({ siswa: rows, periode: p });
});

guru.put("/nilai", async (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const me = c.get("user") as any;
  const { kelas_id, mapel_id, nilai } = await c.req.json();
  if (!kelas_id || !mapel_id || !Array.isArray(nilai))
    return c.json({ error: "kelas_id, mapel_id, nilai wajib diisi" }, 400);
  if (!cekAjar(gid, mapel_id, kelas_id))
    return c.json({ error: "Anda tidak mengajar mapel ini di kelas ini" }, 403);
  const p = periodeAktif();
  let tersimpan = 0;
  const gagal: string[] = [];
  const simpan = db.transaction(() => {
    const up = db.query(
      `INSERT INTO nilai (siswa_id, mapel_id, tahun_ajaran, semester, nilai_angka, updated_by, updated_at)
       VALUES (?,?,?,?,?,? ,datetime('now'))
       ON CONFLICT(siswa_id, mapel_id, tahun_ajaran, semester)
       DO UPDATE SET nilai_angka = excluded.nilai_angka, updated_by = excluded.updated_by, updated_at = datetime('now')`
    );
    for (const item of nilai) {
      const v = item.nilai_angka;
      if (v === null || v === undefined || v === "") continue; // kosong = lewati
      const angka = Number(v);
      if (Number.isNaN(angka) || angka < 0 || angka > 100) {
        gagal.push(`Siswa ID ${item.siswa_id}: nilai harus 0–100`);
        continue;
      }
      const sw = db
        .query("SELECT id, nama FROM siswa WHERE id = ? AND kelas_id = ?")
        .get(item.siswa_id, kelas_id) as any;
      if (!sw) {
        gagal.push(`Siswa ID ${item.siswa_id}: bukan siswa kelas ini`);
        continue;
      }
      up.run(item.siswa_id, mapel_id, p.tahun_ajaran, p.semester, angka, me.id);
      tersimpan++;
    }
  });
  simpan();
  return c.json({ ok: true, tersimpan, gagal });
});

guru.get("/nilai/template", (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const kelas_id = c.req.query("kelas_id");
  const mapel_id = c.req.query("mapel_id");
  if (!kelas_id || !mapel_id)
    return c.json({ error: "kelas_id dan mapel_id wajib diisi" }, 400);
  if (!cekAjar(gid, mapel_id, kelas_id))
    return c.json({ error: "Anda tidak mengajar mapel ini di kelas ini" }, 403);
  const p = periodeAktif();
  const rows = db
    .query(
      `SELECT s.nis, s.nama, k.nama AS kelas, n.nilai_angka
       FROM siswa s
       JOIN kelas k ON k.id = s.kelas_id
       LEFT JOIN nilai n ON n.siswa_id = s.id AND n.mapel_id = ?
         AND n.tahun_ajaran = ? AND n.semester = ?
       WHERE s.kelas_id = ? ORDER BY s.nama`
    )
    .all(mapel_id, p.tahun_ajaran, p.semester, kelas_id) as any[];
  const lines = ["nis,nama,kelas,nilai"];
  for (const r of rows)
    lines.push(
      [r.nis, r.nama, r.kelas, r.nilai_angka ?? ""].map(csvField).join(",")
    );
  const kelasNama = rows[0]?.kelas ?? "kelas";
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="template-nilai-${kelasNama}.csv"`
  );
  return c.body("\uFEFF" + lines.join("\n"));
});

guru.post("/nilai/import", async (c) => {
  const gid = guruId(c);
  if (!gid) return c.json({ error: "Data guru tidak ditemukan" }, 404);
  const me = c.get("user") as any;
  const kelas_id = c.req.query("kelas_id");
  const mapel_id = c.req.query("mapel_id");
  if (!kelas_id || !mapel_id)
    return c.json({ error: "kelas_id dan mapel_id wajib diisi" }, 400);
  if (!cekAjar(gid, mapel_id, kelas_id))
    return c.json({ error: "Anda tidak mengajar mapel ini di kelas ini" }, 403);
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string")
    return c.json({ error: "File CSV tidak ditemukan" }, 400);
  const text = await (file as File).text();
  const rows = parseCSV(text);
  if (!rows.length) return c.json({ error: "File kosong" }, 400);
  let start = 0;
  if (/nis/i.test(rows[0][0] ?? "")) start = 1;
  const p = periodeAktif();
  let tersimpan = 0;
  const gagal: string[] = [];
  const simpan = db.transaction(() => {
    const up = db.query(
      `INSERT INTO nilai (siswa_id, mapel_id, tahun_ajaran, semester, nilai_angka, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(siswa_id, mapel_id, tahun_ajaran, semester)
       DO UPDATE SET nilai_angka = excluded.nilai_angka, updated_by = excluded.updated_by, updated_at = datetime('now')`
    );
    for (let i = start; i < rows.length; i++) {
      const no = i + 1;
      const nis = (rows[i][0] ?? "").trim();
      const nilaiRaw = (rows[i][3] ?? "").trim();
      if (!nis) {
        gagal.push(`Baris ${no}: NIS kosong`);
        continue;
      }
      if (nilaiRaw === "") continue; // kosong = lewati
      const angka = Number(nilaiRaw.replace(",", "."));
      if (Number.isNaN(angka) || angka < 0 || angka > 100) {
        gagal.push(`Baris ${no}: nilai "${nilaiRaw}" harus 0–100`);
        continue;
      }
      const sw = db
        .query("SELECT id FROM siswa WHERE nis = ? AND kelas_id = ?")
        .get(nis, kelas_id) as any;
      if (!sw) {
        gagal.push(`Baris ${no}: NIS "${nis}" bukan siswa kelas ini`);
        continue;
      }
      up.run(sw.id, mapel_id, p.tahun_ajaran, p.semester, angka, me.id);
      tersimpan++;
    }
  });
  simpan();
  return c.json({ ok: true, tersimpan, gagal });
});

export default guru;
