import { Hono } from "hono";
import { db } from "../db";
import { requireRole } from "../auth";
import { parseCSV, csvField, validTanggalISO } from "../util";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

const admin = new Hono();
admin.use(requireRole("admin"));

/* ================= USERS ================= */

admin.get("/users", (c) => {
  const rows = db
    .query(
      `SELECT u.id, u.username, u.role, u.created_at,
              g.id AS guru_id, g.nama AS guru_nama,
              s.id AS siswa_id, s.nama AS siswa_nama, s.nis
       FROM users u
       LEFT JOIN guru g ON g.user_id = u.id
       LEFT JOIN siswa s ON s.user_id = u.id
       ORDER BY u.id`
    )
    .all();
  return c.json({ users: rows });
});

admin.post("/users", async (c) => {
  const { username, password, role, nama, nip, siswa_id } = await c.req.json();
  if (!username || !password || !role)
    return c.json({ error: "Username, password, dan role wajib diisi" }, 400);
  if (!["admin", "guru", "siswa"].includes(role))
    return c.json({ error: "Role tidak valid" }, 400);
  if (role === "guru" && !nama)
    return c.json({ error: "Nama guru wajib diisi" }, 400);
  if (role === "siswa" && !siswa_id)
    return c.json({ error: "Untuk role siswa, pilih data siswa" }, 400);

  const hash = await Bun.password.hash(String(password));
  try {
    const r = db
      .query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,datetime('now'))"
      )
      .run(String(username).trim(), hash, role);
    const uid = Number(r.lastInsertRowid);
    if (role === "guru") {
      db.query("INSERT INTO guru (user_id, nama, nip) VALUES (?,?,?)").run(
        uid,
        nama,
        nip || null
      );
    }
    if (role === "siswa") {
      const sw = db.query("SELECT id, user_id FROM siswa WHERE id = ?").get(
        siswa_id
      ) as any;
      if (!sw) {
        db.query("DELETE FROM users WHERE id = ?").run(uid);
        return c.json({ error: "Data siswa tidak ditemukan" }, 400);
      }
      if (sw.user_id) {
        db.query("DELETE FROM users WHERE id = ?").run(uid);
        return c.json({ error: "Siswa tersebut sudah punya akun" }, 400);
      }
      db.query("UPDATE siswa SET user_id = ? WHERE id = ?").run(uid, siswa_id);
    }
    return c.json({ ok: true, id: uid });
  } catch {
    return c.json({ error: "Username sudah dipakai" }, 400);
  }
});

admin.put("/users/:id", async (c) => {
  const id = c.req.param("id");
  const { username, password, nama, nip } = await c.req.json();
  const u = db.query("SELECT * FROM users WHERE id = ?").get(id) as any;
  if (!u) return c.json({ error: "User tidak ditemukan" }, 404);
  if (username && username !== u.username) {
    try {
      db.query("UPDATE users SET username = ? WHERE id = ?").run(username, id);
    } catch {
      return c.json({ error: "Username sudah dipakai" }, 400);
    }
  }
  if (password)
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(
      await Bun.password.hash(String(password)),
      id
    );
  if (u.role === "guru") {
    const g = db.query("SELECT id FROM guru WHERE user_id = ?").get(id) as any;
    if (g)
      db.query(
        "UPDATE guru SET nama = COALESCE(?, nama), nip = COALESCE(?, nip) WHERE id = ?"
      ).run(nama ?? null, nip ?? null, g.id);
  }
  return c.json({ ok: true });
});

admin.delete("/users/:id", (c) => {
  const id = c.req.param("id");
  const me = c.get("user") as any;
  if (Number(id) === me.id)
    return c.json({ error: "Tidak bisa menghapus akun sendiri" }, 400);
  const ada = db.query("SELECT id FROM users WHERE id = ?").get(id);
  if (!ada) return c.json({ error: "User tidak ditemukan" }, 404);
  const g = db.query("SELECT id FROM guru WHERE user_id = ?").get(id) as any;
  if (g) {
    db.query("DELETE FROM guru_mapel WHERE guru_id = ?").run(g.id);
    db.query("DELETE FROM rentang_nilai WHERE guru_id = ?").run(g.id);
    db.query("UPDATE kelas SET wali_guru_id = NULL WHERE wali_guru_id = ?").run(
      g.id
    );
    db.query("DELETE FROM guru WHERE id = ?").run(g.id);
  }
  db.query("UPDATE siswa SET user_id = NULL WHERE user_id = ?").run(id);
  db.query("DELETE FROM sessions WHERE user_id = ?").run(id);
  db.query("DELETE FROM users WHERE id = ?").run(id);
  return c.json({ ok: true });
});

/* ================= MAPEL ================= */

admin.get("/mapel", (c) => {
  const rows = db
    .query("SELECT * FROM mapel ORDER BY urutan, id")
    .all();
  return c.json({ mapel: rows });
});

admin.post("/mapel", async (c) => {
  const { nama, kode, urutan, aktif } = await c.req.json();
  if (!nama || !kode)
    return c.json({ error: "Nama dan kode mapel wajib diisi" }, 400);
  try {
    const maxU = (
      db.query("SELECT COALESCE(MAX(urutan),0) AS m FROM mapel").get() as any
    ).m;
    const r = db
      .query("INSERT INTO mapel (nama, kode, urutan, aktif) VALUES (?,?,?,?)")
      .run(nama, String(kode).toUpperCase().trim(), urutan ?? maxU + 1, aktif ?? 1);
    return c.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch {
    return c.json({ error: "Kode mapel sudah dipakai" }, 400);
  }
});

admin.put("/mapel/:id", async (c) => {
  const id = c.req.param("id");
  const { nama, kode, urutan, aktif } = await c.req.json();
  const ada = db.query("SELECT id FROM mapel WHERE id = ?").get(id);
  if (!ada) return c.json({ error: "Mapel tidak ditemukan" }, 404);
  try {
    db.query(
      `UPDATE mapel SET nama = COALESCE(?, nama), kode = COALESCE(?, kode),
       urutan = COALESCE(?, urutan), aktif = COALESCE(?, aktif) WHERE id = ?`
    ).run(
      nama ?? null,
      kode ? String(kode).toUpperCase().trim() : null,
      urutan ?? null,
      aktif ?? null,
      id
    );
  } catch {
    return c.json({ error: "Kode mapel sudah dipakai" }, 400);
  }
  return c.json({ ok: true });
});

admin.delete("/mapel/:id", (c) => {
  const id = c.req.param("id");
  const dipakai = (
    db
      .query(
        `SELECT (SELECT COUNT(*) FROM nilai WHERE mapel_id = ?)
         + (SELECT COUNT(*) FROM rentang_nilai WHERE mapel_id = ?)
         + (SELECT COUNT(*) FROM guru_mapel WHERE mapel_id = ?) AS jml`
      )
      .get(id, id, id) as any
  ).jml;
  if (dipakai > 0)
    return c.json(
      {
        error:
          "Mapel sudah dipakai (ada nilai/rentang/penugasan). Nonaktifkan saja lewat kolom Aktif.",
      },
      400
    );
  db.query("DELETE FROM mapel WHERE id = ?").run(id);
  return c.json({ ok: true });
});

/* ================= KELAS ================= */

admin.get("/kelas", (c) => {
  const rows = db
    .query(
      `SELECT k.*, g.nama AS wali_nama,
              (SELECT COUNT(*) FROM siswa s WHERE s.kelas_id = k.id) AS jml_siswa
       FROM kelas k LEFT JOIN guru g ON g.id = k.wali_guru_id
       ORDER BY k.tingkat, k.nama`
    )
    .all();
  return c.json({ kelas: rows });
});

admin.post("/kelas", async (c) => {
  const { nama, tingkat, wali_guru_id, tahun_ajaran, semester } =
    await c.req.json();
  if (!nama) return c.json({ error: "Nama kelas wajib diisi" }, 400);
  const r = db
    .query(
      "INSERT INTO kelas (nama, tingkat, wali_guru_id, tahun_ajaran, semester) VALUES (?,?,?,?,?)"
    )
    .run(
      nama,
      tingkat || null,
      wali_guru_id || null,
      tahun_ajaran || null,
      semester || null
    );
  return c.json({ ok: true, id: Number(r.lastInsertRowid) });
});

admin.put("/kelas/:id", async (c) => {
  const id = c.req.param("id");
  const { nama, tingkat, wali_guru_id, tahun_ajaran, semester } =
    await c.req.json();
  const ada = db.query("SELECT id FROM kelas WHERE id = ?").get(id);
  if (!ada) return c.json({ error: "Kelas tidak ditemukan" }, 404);
  db.query(
    `UPDATE kelas SET nama = COALESCE(?, nama), tingkat = COALESCE(?, tingkat),
     wali_guru_id = ?, tahun_ajaran = COALESCE(?, tahun_ajaran),
     semester = COALESCE(?, semester) WHERE id = ?`
  ).run(
    nama ?? null,
    tingkat ?? null,
    wali_guru_id ?? null,
    tahun_ajaran ?? null,
    semester ?? null,
    id
  );
  return c.json({ ok: true });
});

admin.delete("/kelas/:id", (c) => {
  const id = c.req.param("id");
  const jml = (
    db.query("SELECT COUNT(*) AS j FROM siswa WHERE kelas_id = ?").get(id) as any
  ).j;
  if (jml > 0)
    return c.json(
      { error: `Kelas masih berisi ${jml} siswa. Pindahkan dulu siswanya.` },
      400
    );
  db.query("DELETE FROM guru_mapel WHERE kelas_id = ?").run(id);
  db.query("DELETE FROM kelas WHERE id = ?").run(id);
  return c.json({ ok: true });
});

/* ================= SISWA ================= */

admin.get("/siswa", (c) => {
  const kelas_id = c.req.query("kelas_id");
  let sql = `SELECT s.*, k.nama AS kelas_nama, u.username
             FROM siswa s
             LEFT JOIN kelas k ON k.id = s.kelas_id
             LEFT JOIN users u ON u.id = s.user_id`;
  const params: any[] = [];
  if (kelas_id) {
    sql += " WHERE s.kelas_id = ?";
    params.push(kelas_id);
  }
  sql += " ORDER BY k.nama, s.nama";
  // Pagination: ?page=1&limit=25. Tanpa param page → semua (kompatibel pemanggil lama).
  const page = Math.max(0, parseInt(c.req.query("page") || "0", 10) || 0);
  if (!page) return c.json({ siswa: db.query(sql).all(...params) });
  const limit = Math.min(
    200,
    Math.max(1, parseInt(c.req.query("limit") || "25", 10) || 25)
  );
  const total = (
    db.query(`SELECT COUNT(*) n FROM (${sql})`).get(...params) as any
  ).n as number;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const p = Math.min(page, totalPages);
  const rows = db
    .query(sql + " LIMIT ? OFFSET ?")
    .all(...params, limit, (p - 1) * limit);
  return c.json({ siswa: rows, total, page: p, limit, totalPages });
});

admin.post("/siswa", async (c) => {
  const { nis, nama, kelas_id, agama, jenis_kelamin } = await c.req.json();
  if (!nis || !nama)
    return c.json({ error: "NIS dan nama wajib diisi" }, 400);
  const jk = jenis_kelamin || null;
  if (jk && !["L", "P"].includes(jk))
    return c.json({ error: "Jenis kelamin harus L atau P" }, 400);
  try {
    const hash = await Bun.password.hash(String(nis));
    const ur = db
      .query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,datetime('now'))"
      )
      .run(String(nis).trim(), hash, "siswa");
    const uid = Number(ur.lastInsertRowid);
    const sr = db
      .query(
        "INSERT INTO siswa (user_id, nis, nama, kelas_id, agama, jenis_kelamin) VALUES (?,?,?,?,?,?)"
      )
      .run(uid, String(nis).trim(), nama, kelas_id || null, agama || null, jk);
    return c.json({
      ok: true,
      id: Number(sr.lastInsertRowid),
      username: String(nis).trim(),
      password: String(nis).trim(),
    });
  } catch {
    return c.json({ error: "NIS sudah dipakai" }, 400);
  }
});

admin.put("/siswa/:id", async (c) => {
  const id = c.req.param("id");
  const { nis, nama, kelas_id, agama, jenis_kelamin } = await c.req.json();
  const sw = db.query("SELECT * FROM siswa WHERE id = ?").get(id) as any;
  if (!sw) return c.json({ error: "Siswa tidak ditemukan" }, 404);
  const jk = jenis_kelamin || null;
  if (jk && !["L", "P"].includes(jk))
    return c.json({ error: "Jenis kelamin harus L atau P" }, 400);
  try {
    db.query(
      `UPDATE siswa SET nis = COALESCE(?, nis), nama = COALESCE(?, nama),
       kelas_id = ?, agama = ?, jenis_kelamin = ? WHERE id = ?`
    ).run(
      nis ? String(nis).trim() : null,
      nama ?? null,
      kelas_id ?? null,
      agama ?? null,
      jk,
      id
    );
    // sinkronkan username bila akun dibuat otomatis (username == NIS lama)
    if (nis && sw.user_id) {
      const u = db
        .query("SELECT username FROM users WHERE id = ?")
        .get(sw.user_id) as any;
      if (u && u.username === sw.nis)
        db.query("UPDATE users SET username = ? WHERE id = ?").run(
          String(nis).trim(),
          sw.user_id
        );
    }
  } catch {
    return c.json({ error: "NIS sudah dipakai" }, 400);
  }
  return c.json({ ok: true });
});

admin.delete("/siswa/:id", (c) => {
  const id = c.req.param("id");
  const sw = db.query("SELECT * FROM siswa WHERE id = ?").get(id) as any;
  if (!sw) return c.json({ error: "Siswa tidak ditemukan" }, 404);
  db.query("DELETE FROM nilai WHERE siswa_id = ?").run(id);
  db.query("DELETE FROM catatan_raport WHERE siswa_id = ?").run(id);
  if (sw.user_id) {
    const u = db
      .query("SELECT username FROM users WHERE id = ?")
      .get(sw.user_id) as any;
    db.query("DELETE FROM sessions WHERE user_id = ?").run(sw.user_id);
    db.query("DELETE FROM users WHERE id = ?").run(sw.user_id);
    void u;
  }
  db.query("DELETE FROM siswa WHERE id = ?").run(id);
  return c.json({ ok: true });
});

admin.get("/siswa/export", (c) => {
  const rows = db
    .query(
      `SELECT s.nis, s.nama, k.nama AS kelas, s.agama, s.jenis_kelamin
       FROM siswa s LEFT JOIN kelas k ON k.id = s.kelas_id
       ORDER BY k.nama, s.nama`
    )
    .all() as any[];
  const lines = ["nis,nama,kelas,agama,jenis_kelamin"];
  for (const r of rows)
    lines.push(
      [r.nis, r.nama, r.kelas, r.agama, r.jenis_kelamin].map(csvField).join(",")
    );
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="data-siswa.csv"');
  return c.body("\uFEFF" + lines.join("\n"));
});

admin.post("/siswa/import", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string")
    return c.json({ error: "File CSV tidak ditemukan" }, 400);
  const text = await (file as File).text();
  const rows = parseCSV(text);
  if (!rows.length) return c.json({ error: "File kosong" }, 400);
  let start = 0;
  if (/nis/i.test(rows[0][0] ?? "")) start = 1;
  // Sinkronisasi via NIS: belum ada → tambah; ada & berubah → update; sama persis → abaikan
  let sukses = 0,
    dibuat = 0,
    diupdate = 0,
    diabaikan = 0;
  const gagal: string[] = [];
  for (let i = start; i < rows.length; i++) {
    const [nis, nama, kelasNama, agama, jkRaw] = rows[i].map((x) =>
      (x ?? "").trim()
    );
    const no = i + 1;
    if (!nis || !nama) {
      gagal.push(`Baris ${no}: NIS/nama kosong`);
      continue;
    }
    const jk = (jkRaw || "").toUpperCase();
    if (jk && !["L", "P"].includes(jk)) {
      gagal.push(`Baris ${no}: jenis kelamin harus L/P`);
      continue;
    }
    let kelas_id: number | null = null;
    if (kelasNama) {
      const k = db
        .query("SELECT id FROM kelas WHERE LOWER(nama) = LOWER(?)")
        .get(kelasNama) as any;
      if (!k) {
        gagal.push(`Baris ${no}: kelas "${kelasNama}" tidak ditemukan`);
        continue;
      }
      kelas_id = k.id;
    }
    try {
      const ex = db
        .query(
          "SELECT id, nama, kelas_id, agama, jenis_kelamin FROM siswa WHERE nis = ?"
        )
        .get(nis) as any;
      if (!ex) {
        const hash = await Bun.password.hash(nis);
        const ur = db
          .query(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,datetime('now'))"
          )
          .run(nis, hash, "siswa");
        db.query(
          "INSERT INTO siswa (user_id, nis, nama, kelas_id, agama, jenis_kelamin) VALUES (?,?,?,?,?,?)"
        ).run(
          Number(ur.lastInsertRowid),
          nis,
          nama,
          kelas_id,
          agama || null,
          jk || null
        );
        dibuat++;
      } else {
        const sama =
          ex.nama === nama &&
          (ex.kelas_id ?? null) === kelas_id &&
          (ex.agama || "") === (agama || "") &&
          (ex.jenis_kelamin || null) === (jk || null);
        if (sama) {
          diabaikan++;
          continue;
        }
        db.query(
          "UPDATE siswa SET nama=?, kelas_id=?, agama=?, jenis_kelamin=? WHERE id=?"
        ).run(nama, kelas_id, agama || null, jk || null, ex.id);
        diupdate++;
      }
      sukses++;
    } catch (e) {
      gagal.push(
        `Baris ${no}: gagal menyimpan (${(e as Error)?.message ?? "galat"})`
      );
    }
  }
  return c.json({ ok: true, sukses, dibuat, diupdate, diabaikan, gagal });
});

/* ================= STATISTIK ================= */

/** Rekap jumlah data untuk dashboard admin. */
admin.get("/statistik", (c) => {
  const hitung = (sql: string) => (db.query(sql).get() as any).n as number;
  return c.json({
    guru: hitung("SELECT COUNT(*) n FROM guru"),
    siswa: hitung("SELECT COUNT(*) n FROM siswa"),
    kelas: hitung("SELECT COUNT(*) n FROM kelas"),
    mapel: hitung("SELECT COUNT(*) n FROM mapel WHERE aktif=1"),
  });
});

/* ================= GURU ================= */

admin.get("/guru", (c) => {
  const rows = db
    .query(
      `SELECT g.*, u.username,
              (SELECT COUNT(*) FROM guru_mapel gm WHERE gm.guru_id = g.id) AS jml_ajar
       FROM guru g LEFT JOIN users u ON u.id = g.user_id
       ORDER BY g.nama`
    )
    .all();
  return c.json({ guru: rows });
});

admin.post("/guru", async (c) => {
  const { username, password, nama, nip, is_bk, is_ekskul, is_staf, jabatan } =
    await c.req.json();
  if (!username || !password || !nama)
    return c.json({ error: "Username, password, dan nama wajib diisi" }, 400);
  if (is_staf && !String(jabatan || "").trim())
    return c.json({ error: "Jabatan wajib diisi bila Staff dicentang" }, 400);
  const hash = await Bun.password.hash(String(password));
  try {
    const ur = db
      .query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,datetime('now'))"
      )
      .run(String(username).trim(), hash, "guru");
    const uid = Number(ur.lastInsertRowid);
    const gr = db
      .query(
        "INSERT INTO guru (user_id, nama, nip, is_bk, is_ekskul, is_staf, jabatan) VALUES (?,?,?,?,?,?,?)"
      )
      .run(
        uid,
        nama,
        nip || null,
        is_bk ? 1 : 0,
        is_ekskul ? 1 : 0,
        is_staf ? 1 : 0,
        is_staf ? String(jabatan).trim() : null
      );
    return c.json({ ok: true, id: Number(gr.lastInsertRowid) });
  } catch {
    return c.json({ error: "Username sudah dipakai" }, 400);
  }
});

admin.put("/guru/:id", async (c) => {
  const id = c.req.param("id");
  const { nama, nip, is_bk, is_ekskul, is_staf, jabatan } = await c.req.json();
  const cur = db.query("SELECT * FROM guru WHERE id = ?").get(id) as any;
  if (!cur) return c.json({ error: "Guru tidak ditemukan" }, 404);
  // jabatan wajib bila hasil akhirnya berstatus staf
  const stafAkhir = is_staf === undefined ? !!cur.is_staf : !!is_staf;
  const jabatanAkhir =
    jabatan === undefined ? cur.jabatan : String(jabatan || "").trim() || null;
  if (stafAkhir && !jabatanAkhir)
    return c.json({ error: "Jabatan wajib diisi bila Staff dicentang" }, 400);
  db.query(
    `UPDATE guru SET nama = COALESCE(?, nama), nip = ?,
     is_bk = COALESCE(?, is_bk), is_ekskul = COALESCE(?, is_ekskul),
     is_staf = COALESCE(?, is_staf), jabatan = ? WHERE id = ?`
  ).run(
    nama ?? null,
    nip ?? null,
    is_bk === undefined ? null : is_bk ? 1 : 0,
    is_ekskul === undefined ? null : is_ekskul ? 1 : 0,
    is_staf === undefined ? null : is_staf ? 1 : 0,
    jabatanAkhir,
    id
  );
  return c.json({ ok: true });
});

admin.delete("/guru/:id", (c) => {
  const id = c.req.param("id");
  const g = db.query("SELECT * FROM guru WHERE id = ?").get(id) as any;
  if (!g) return c.json({ error: "Guru tidak ditemukan" }, 404);
  db.query("DELETE FROM guru_mapel WHERE guru_id = ?").run(id);
  db.query("DELETE FROM rentang_nilai WHERE guru_id = ?").run(id);
  db.query("UPDATE kelas SET wali_guru_id = NULL WHERE wali_guru_id = ?").run(id);
  if (g.user_id) {
    db.query("DELETE FROM sessions WHERE user_id = ?").run(g.user_id);
    db.query("DELETE FROM users WHERE id = ?").run(g.user_id);
  }
  db.query("DELETE FROM guru WHERE id = ?").run(id);
  return c.json({ ok: true });
});

admin.get("/guru/:id/ajar", (c) => {
  const id = c.req.param("id");
  const rows = db
    .query(
      `SELECT gm.mapel_id, m.nama AS mapel_nama, m.kode AS mapel_kode,
              gm.kelas_id, k.nama AS kelas_nama
       FROM guru_mapel gm
       JOIN mapel m ON m.id = gm.mapel_id
       JOIN kelas k ON k.id = gm.kelas_id
       WHERE gm.guru_id = ? ORDER BY k.nama, m.urutan`
    )
    .all(id);
  return c.json({ ajar: rows });
});

admin.put("/guru/:id/ajar", async (c) => {
  const id = c.req.param("id");
  const { daftar } = await c.req.json();
  const ada = db.query("SELECT id FROM guru WHERE id = ?").get(id);
  if (!ada) return c.json({ error: "Guru tidak ditemukan" }, 404);
  if (!Array.isArray(daftar))
    return c.json({ error: "daftar harus berupa array" }, 400);
  for (const d of daftar) {
    const m = db.query("SELECT id FROM mapel WHERE id = ?").get(d.mapel_id);
    const k = db.query("SELECT id FROM kelas WHERE id = ?").get(d.kelas_id);
    if (!m || !k)
      return c.json({ error: "mapel_id/kelas_id tidak valid" }, 400);
  }
  const ganti = db.transaction(() => {
    db.query("DELETE FROM guru_mapel WHERE guru_id = ?").run(id);
    const ins = db.query(
      "INSERT OR IGNORE INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?,?,?)"
    );
    for (const d of daftar) ins.run(id, d.mapel_id, d.kelas_id);
  });
  ganti();
  return c.json({ ok: true, jumlah: daftar.length });
});

/* ============ IMPORT/EXPORT CSV GURU ============
 * Kolom: username,nama,nip,password,is_bk,is_ekskul,is_staf,jabatan,mapel,kelas
 * - Dicocokkan via username: sudah ada → diperbarui, baru → dibuat
 * - password: kosong = tidak diubah (guru baru: default = username)
 * - is_bk/is_ekskul/is_staf: 1/ya/yes/true/y (case-insensitive) = ya
 * - jabatan wajib bila is_staf = ya
 * - mapel: kode dipisah ";" ; kelas: nama dipisah ";" → cross product
 *   MENGGANTIKAN penugasan mengajar lama (hanya bila kolom mapel/kelas ada di file)
 */

function parseYaCSV(v: unknown): boolean {
  return ["1", "ya", "yes", "true", "y"].includes(
    String(v ?? "").trim().toLowerCase()
  );
}

const KOLOM_GURU_CSV = [
  "username",
  "nama",
  "nip",
  "password",
  "is_bk",
  "is_ekskul",
  "is_staf",
  "jabatan",
  "mapel",
  "kelas",
];

admin.get("/guru/template", (c) => {
  const lines = [
    KOLOM_GURU_CSV.join(","),
    [
      "budi.santoso",
      "Budi Santoso",
      "198001012005011001",
      "",
      "0",
      "0",
      "0",
      "",
      "MTK",
      "7A;7B",
    ]
      .map(csvField)
      .join(","),
  ];
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="template-guru.csv"');
  return c.body("\uFEFF" + lines.join("\n"));
});

admin.get("/guru/export", (c) => {
  const rows = db
    .query(
      `SELECT u.username, g.nama, g.nip, g.is_bk, g.is_ekskul, g.is_staf, g.jabatan,
        (SELECT GROUP_CONCAT(kode, ';') FROM
           (SELECT DISTINCT m.kode AS kode FROM guru_mapel gm
            JOIN mapel m ON m.id = gm.mapel_id WHERE gm.guru_id = g.id)) AS mapel,
        (SELECT GROUP_CONCAT(nama, ';') FROM
           (SELECT DISTINCT k.nama AS nama FROM guru_mapel gm
            JOIN kelas k ON k.id = gm.kelas_id WHERE gm.guru_id = g.id)) AS kelas
       FROM guru g JOIN users u ON u.id = g.user_id
       ORDER BY g.nama`
    )
    .all() as any[];
  const lines = [KOLOM_GURU_CSV.join(",")];
  for (const r of rows)
    lines.push(
      [
        r.username,
        r.nama,
        r.nip ?? "",
        "",
        r.is_bk ? "1" : "0",
        r.is_ekskul ? "1" : "0",
        r.is_staf ? "1" : "0",
        r.jabatan ?? "",
        r.mapel ?? "",
        r.kelas ?? "",
      ]
        .map(csvField)
        .join(",")
    );
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="data-guru.csv"');
  return c.body("\uFEFF" + lines.join("\n"));
});

admin.post("/guru/import", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string")
    return c.json({ error: "File CSV tidak ditemukan" }, 400);
  const text = await (file as File).text();
  const rows = parseCSV(text);
  if (!rows.length) return c.json({ error: "File kosong" }, 400);
  // petakan kolom via header (case-insensitive); fallback posisi bila tanpa header
  const idx: Record<string, number> = {};
  let start = 0;
  if (/username/i.test(rows[0][0] ?? "")) {
    start = 1;
    rows[0].forEach((h, i) => {
      idx[String(h ?? "").trim().toLowerCase()] = i;
    });
  } else {
    KOLOM_GURU_CSV.forEach((k, i) => {
      idx[k] = i;
    });
  }
  const col = (r: string[], k: string) =>
    idx[k] === undefined ? "" : (r[idx[k]] ?? "").trim();
  const adaKolomTugas = idx["mapel"] !== undefined || idx["kelas"] !== undefined;
  // Sinkronisasi via username: belum ada → tambah; ada & berubah → update; sama persis → abaikan.
  // Baris-baris dengan username sama digabung: pasangan (mapel, kelas) di-union.
  let sukses = 0,
    dibuat = 0,
    diupdate = 0,
    diabaikan = 0;
  const gagal: string[] = [];
  type BarisGuru = {
    nos: number[];
    username: string;
    nama: string;
    nip: string | null;
    pw: string;
    is_bk: boolean;
    is_ekskul: boolean;
    is_staf: boolean;
    jabatan: string | null;
    pasangan: Array<[string, string]>; // [kodeMapel, namaKelas]
  };
  // --- Fase 1: baca baris & kelompokkan per username ---
  const grup = new Map<string, BarisGuru>();
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every((x) => !(x ?? "").trim())) continue;
    const no = i + 1;
    const username = col(r, "username"),
      nama = col(r, "nama");
    if (!username || !nama) {
      gagal.push(`Baris ${no}: username/nama kosong`);
      continue;
    }
    const is_bk = parseYaCSV(col(r, "is_bk")),
      is_ekskul = parseYaCSV(col(r, "is_ekskul")),
      is_staf = parseYaCSV(col(r, "is_staf"));
    const jabatan = col(r, "jabatan") || null;
    if (is_staf && !jabatan) {
      gagal.push(`Baris ${no}: jabatan wajib diisi bila staff=ya`);
      continue;
    }
    const kodeMapel = col(r, "mapel")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    const namaKelas = col(r, "kelas")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    const b: BarisGuru = {
      nos: [no],
      username,
      nama,
      nip: col(r, "nip") || null,
      pw: col(r, "password"),
      is_bk,
      is_ekskul,
      is_staf,
      jabatan,
      pasangan: [],
    };
    for (const m of kodeMapel)
      for (const k of namaKelas)
        if (!b.pasangan.some(([a, c]) => a === m && c === k))
          b.pasangan.push([m, k]);
    const g = grup.get(username);
    if (!g) grup.set(username, b);
    else {
      for (const [m, k] of b.pasangan)
        if (!g.pasangan.some(([a, c]) => a === m && c === k))
          g.pasangan.push([m, k]);
      g.nos.push(no);
      // field lain ikut baris terakhir (boleh mengoreksi baris sebelumnya)
      g.nama = b.nama;
      g.nip = b.nip;
      g.is_bk = b.is_bk;
      g.is_ekskul = b.is_ekskul;
      g.is_staf = b.is_staf;
      g.jabatan = b.jabatan;
      if (b.pw) g.pw = b.pw;
    }
  }
  // --- Fase 2: proses tiap guru ---
  for (const g of grup.values()) {
    const label =
      g.nos.length > 1 ? `Baris ${g.nos.join(",")}` : `Baris ${g.nos[0]}`;
    const { username, nama, nip, pw, is_bk, is_ekskul, is_staf } = g;
    const jabatan = g.jabatan;
    // validasi mapel & kelas dulu sebelum mengubah apa pun
    let tugas: Array<[number, number]> | null = null;
    if (adaKolomTugas) {
      tugas = [];
      const cacheM = new Map<string, number>(),
        cacheK = new Map<string, number>();
      let batal = false;
      for (const [kd, nk] of g.pasangan) {
        let mid = cacheM.get(kd.toLowerCase());
        if (mid === undefined) {
          const mm = db
            .query("SELECT id FROM mapel WHERE LOWER(kode) = LOWER(?)")
            .get(kd) as any;
          if (!mm) {
            gagal.push(`${label}: kode mapel "${kd}" tidak ditemukan`);
            batal = true;
            break;
          }
          mid = mm.id;
          cacheM.set(kd.toLowerCase(), mid);
        }
        let kid = cacheK.get(nk.toLowerCase());
        if (kid === undefined) {
          const kk = db
            .query("SELECT id FROM kelas WHERE LOWER(nama) = LOWER(?)")
            .get(nk) as any;
          if (!kk) {
            gagal.push(`${label}: kelas "${nk}" tidak ditemukan`);
            batal = true;
            break;
          }
          kid = kk.id;
          cacheK.set(nk.toLowerCase(), kid);
        }
        tugas.push([mid, kid]);
      }
      if (batal) continue;
    }
    try {
      const ex = db
        .query(
          "SELECT g.id, g.user_id, g.nama, g.nip, g.is_bk, g.is_ekskul, g.is_staf, g.jabatan FROM guru g JOIN users u ON u.id = g.user_id WHERE u.username = ?"
        )
        .get(username) as any;
      const fJabatan = is_staf ? jabatan : null;
      let gid: number;
      if (ex) {
        // bandingkan dulu: sama persis → abaikan
        let berubah =
          ex.nama !== nama ||
          (ex.nip ?? null) !== nip ||
          !!ex.is_bk !== is_bk ||
          !!ex.is_ekskul !== is_ekskul ||
          !!ex.is_staf !== is_staf ||
          (ex.jabatan ?? null) !== fJabatan;
        if (pw) berubah = true; // password diisi = perubahan
        if (adaKolomTugas) {
          const baru: string[] = (tugas as Array<[number, number]>)
            .map(([m, k]) => `${m}:${k}`)
            .sort();
          const lama = (
            db
              .query(
                "SELECT mapel_id, kelas_id FROM guru_mapel WHERE guru_id = ? ORDER BY mapel_id, kelas_id"
              )
              .all(ex.id) as any[]
          ).map((a) => `${a.mapel_id}:${a.kelas_id}`);
          if (JSON.stringify(lama) !== JSON.stringify(baru)) berubah = true;
        }
        if (!berubah) {
          diabaikan++;
          continue;
        }
        db.query(
          `UPDATE guru SET nama=?, nip=?, is_bk=?, is_ekskul=?, is_staf=?, jabatan=? WHERE id=?`
        ).run(
          nama,
          nip,
          is_bk ? 1 : 0,
          is_ekskul ? 1 : 0,
          is_staf ? 1 : 0,
          fJabatan,
          ex.id
        );
        if (pw)
          db
            .query("UPDATE users SET password_hash=? WHERE id=?")
            .run(await Bun.password.hash(pw), ex.user_id);
        gid = ex.id;
        diupdate++;
      } else {
        const hash = await Bun.password.hash(pw || username);
        const ur = db
          .query(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,datetime('now'))"
          )
          .run(username, hash, "guru");
        const gr = db
          .query(
            "INSERT INTO guru (user_id, nama, nip, is_bk, is_ekskul, is_staf, jabatan) VALUES (?,?,?,?,?,?,?)"
          )
          .run(
            Number(ur.lastInsertRowid),
            nama,
            nip,
            is_bk ? 1 : 0,
            is_ekskul ? 1 : 0,
            is_staf ? 1 : 0,
            is_staf ? jabatan : null
          );
        gid = Number(gr.lastInsertRowid);
        dibuat++;
      }
      if (tugas !== null) {
        const daftar = tugas;
        const ganti = db.transaction(() => {
          db.query("DELETE FROM guru_mapel WHERE guru_id = ?").run(gid);
          const ins = db.query(
            "INSERT OR IGNORE INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?,?,?)"
          );
          for (const [mid, kid] of daftar) ins.run(gid, mid, kid);
        });
        ganti();
      }
      sukses++;
    } catch (e) {
      gagal.push(
        `${label}: gagal menyimpan (${(e as Error)?.message ?? "galat"})`
      );
    }
  }
  return c.json({ ok: true, sukses, dibuat, diupdate, diabaikan, gagal });
});

/* ================= DESAIN RAPORT ================= */

admin.get("/desain", (c) => {
  const d = db.query("SELECT * FROM desain_raport WHERE id = 1").get();
  if (!d) return c.json({ error: "Desain belum diinisialisasi" }, 404);
  return c.json({ desain: d });
});

admin.put("/desain", async (c) => {
  const {
    nama_sekolah,
    alamat_sekolah,
    kepala_nama,
    kepala_nip,
    kota,
    semester_aktif,
    tahun_ajaran_aktif,
    judul_raport,
    tempat,
    tanggal_raport,
  } = await c.req.json();
  // tanggal_raport: undefined = tidak diubah; "" = kosongkan (pakai tanggal hari ini);
  // selain itu harus format YYYY-MM-DD yang valid.
  let tglMode: "keep" | "clear" | "set" = "keep";
  let tglVal: string | null = null;
  if (tanggal_raport !== undefined) {
    const t = String(tanggal_raport).trim();
    if (t === "") tglMode = "clear";
    else if (!validTanggalISO(t))
      return c.json(
        { error: "Format tanggal tidak valid (pakai YYYY-MM-DD)" },
        400
      );
    else {
      tglMode = "set";
      tglVal = t;
    }
  }
  const sets = [
    "nama_sekolah = COALESCE(?, nama_sekolah)",
    "alamat_sekolah = ?",
    "kepala_nama = ?",
    "kepala_nip = ?",
    "kota = ?",
    "semester_aktif = COALESCE(?, semester_aktif)",
    "tahun_ajaran_aktif = COALESCE(?, tahun_ajaran_aktif)",
    "judul_raport = COALESCE(?, judul_raport)",
    "tempat = COALESCE(?, tempat)",
  ];
  const params: any[] = [
    nama_sekolah ?? null,
    alamat_sekolah ?? null,
    kepala_nama ?? null,
    kepala_nip ?? null,
    kota ?? null,
    semester_aktif ?? null,
    tahun_ajaran_aktif ?? null,
    judul_raport ? String(judul_raport).trim() || null : null,
    tempat ? String(tempat).trim() || null : null,
  ];
  if (tglMode === "clear") sets.push("tanggal_raport = NULL");
  else if (tglMode === "set") {
    sets.push("tanggal_raport = ?");
    params.push(tglVal);
  }
  db.query(`UPDATE desain_raport SET ${sets.join(", ")} WHERE id = 1`).run(
    ...params
  );
  return c.json({ ok: true });
});

const KOP_DIR = "data/uploads";
const KOP_FILES = ["kop.png", "kop.jpg", "kop.jpeg"];

function hapusKopLama() {
  for (const f of KOP_FILES) {
    try {
      unlinkSync(`${KOP_DIR}/${f}`);
    } catch {
      /* belum ada — abaikan */
    }
  }
}

/** Upload gambar kop raport (PNG/JPEG, maks 2MB). File lama ditimpa. */
admin.post("/desain/kop", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string")
    return c.json({ error: "File gambar tidak ditemukan" }, 400);
  const f = file as File;
  const tipe = (f.type || "").toLowerCase();
  if (tipe !== "image/png" && tipe !== "image/jpeg")
    return c.json({ error: "Hanya file PNG atau JPEG yang diterima" }, 400);
  if (f.size > 2 * 1024 * 1024)
    return c.json({ error: "Ukuran file maksimal 2 MB" }, 400);
  const ext = tipe === "image/png" ? "png" : "jpg";
  const nama = `kop.${ext}`;
  if (!existsSync(KOP_DIR)) mkdirSync(KOP_DIR, { recursive: true });
  hapusKopLama();
  await Bun.write(`${KOP_DIR}/${nama}`, f);
  const kop_path = `/uploads/${nama}`;
  db.query("UPDATE desain_raport SET kop_path = ? WHERE id = 1").run(kop_path);
  return c.json({ ok: true, kop_path });
});

/** Hapus gambar kop raport. */
admin.delete("/desain/kop", (c) => {
  hapusKopLama();
  db.query("UPDATE desain_raport SET kop_path = NULL WHERE id = 1").run();
  return c.json({ ok: true });
});

export default admin;
