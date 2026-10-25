import { Hono } from "hono";
import { db } from "../db";
import { requireRole } from "../auth";
import { parseCSV, csvField, validTanggalISO, nisExcel, normalisasiNIS, periodeAktif, catatLog, bungkusCSV, normalisasiTingkat, mapelCocokTingkat, tingkatDefaultKode } from "../util";
import { existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";

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
    catatLog(c, "tambah_pengguna", `username: ${username} (${role})`);
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
  catatLog(c, "ubah_pengguna", `id ${id}`);
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
  catatLog(c, "hapus_pengguna", `id ${id}`);
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
  const { nama, kode, urutan, aktif, tingkat } = await c.req.json();
  if (!nama || !kode)
    return c.json({ error: "Nama dan kode mapel wajib diisi" }, 400);
  // tingkat: daftar tingkat kelas yang mengampu mapel ini ("7,8" / ["7","8"]).
  // Tidak diisi → bawaan menurut kode (SENI 9; PRAK 7,8; lain 7,8,9).
  let tkt: string;
  if (tingkat === undefined || tingkat === null || tingkat === "") {
    tkt = tingkatDefaultKode(kode);
  } else {
    const n = normalisasiTingkat(tingkat);
    if (!n)
      return c.json(
        { error: "Pilih minimal satu tingkat kelas (7/8/9) untuk mapel ini" },
        400
      );
    tkt = n;
  }
  try {
    const maxU = (
      db.query("SELECT COALESCE(MAX(urutan),0) AS m FROM mapel").get() as any
    ).m;
    const r = db
      .query("INSERT INTO mapel (nama, kode, urutan, aktif, tingkat) VALUES (?,?,?,?,?)")
      .run(nama, String(kode).toUpperCase().trim(), urutan ?? maxU + 1, aktif ?? 1, tkt);
    catatLog(c, "tambah_mapel", `${nama} (${kode}) kelas ${tkt}`);
    return c.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch {
    return c.json({ error: "Kode mapel sudah dipakai" }, 400);
  }
});

admin.put("/mapel/:id", async (c) => {
  const id = c.req.param("id");
  const { nama, kode, urutan, aktif, tingkat } = await c.req.json();
  const ada = db.query("SELECT id FROM mapel WHERE id = ?").get(id);
  if (!ada) return c.json({ error: "Mapel tidak ditemukan" }, 404);
  // tingkat tidak dikirim = tidak diubah. Dikirim tapi kosong/invalid = tolak,
  // agar admin tidak sengaja mengosongkan cakupan mapel.
  // Mengubah tingkat TIDAK menyentuh nilai, rentang, maupun penugasan lama.
  let tkt: string | null = null;
  if (tingkat !== undefined && tingkat !== null) {
    tkt = normalisasiTingkat(tingkat);
    if (!tkt)
      return c.json(
        { error: "Pilih minimal satu tingkat kelas (7/8/9) untuk mapel ini" },
        400
      );
  }
  try {
    db.query(
      `UPDATE mapel SET nama = COALESCE(?, nama), kode = COALESCE(?, kode),
       urutan = COALESCE(?, urutan), aktif = COALESCE(?, aktif),
       tingkat = COALESCE(?, tingkat) WHERE id = ?`
    ).run(
      nama ?? null,
      kode ? String(kode).toUpperCase().trim() : null,
      urutan ?? null,
      aktif ?? null,
      tkt,
      id
    );
  } catch {
    return c.json({ error: "Kode mapel sudah dipakai" }, 400);
  }
  catatLog(c, "ubah_mapel", `id ${id}${tkt ? ` tingkat ${tkt}` : ""}`);
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
  catatLog(c, "hapus_mapel", `id ${id}`);
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
  catatLog(c, "tambah_kelas", `${nama}`);
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
  catatLog(c, "ubah_kelas", `id ${id}`);
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
  catatLog(c, "hapus_kelas", `id ${id}`);
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
    catatLog(c, "tambah_siswa", `${nama} (${nis})`);
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
  catatLog(c, "ubah_siswa", `id ${id}`);
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
  catatLog(c, "hapus_siswa", `${sw.nama} (${sw.nis})`);
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
      [nisExcel(r.nis), r.nama, r.kelas, r.agama, r.jenis_kelamin].map(csvField).join(",")
    );
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="data-siswa.csv"');
  return c.body(bungkusCSV(lines));
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
    const [nisRaw, nama, kelasNama, agama, jkRaw] = rows[i].map((x) =>
      (x ?? "").trim()
    );
    const nis = normalisasiNIS(nisRaw);
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
  catatLog(c, "import_siswa", `${sukses} baris (baru ${dibuat}, update ${diupdate})`);
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
      `SELECT g.id, g.user_id, g.nama, g.nip, g.is_bk, g.is_staf, g.jabatan,
              u.username,
              (SELECT COUNT(*) FROM guru_mapel gm WHERE gm.guru_id = g.id) AS jml_ajar,
              CASE WHEN g.is_bk = 1
                THEN (SELECT COUNT(*) FROM bk_kelas b WHERE b.guru_id = g.id)
                ELSE 0 END AS jml_bk
       FROM guru g LEFT JOIN users u ON u.id = g.user_id
       ORDER BY g.nama`
    )
    .all();
  return c.json({ guru: rows });
});

admin.post("/guru", async (c) => {
  const { username, password, nama, nip, is_bk, is_staf, jabatan } =
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
        "INSERT INTO guru (user_id, nama, nip, is_bk, is_staf, jabatan) VALUES (?,?,?,?,?,?)"
      )
      .run(
        uid,
        nama,
        nip || null,
        is_bk ? 1 : 0,
        is_staf ? 1 : 0,
        is_staf ? String(jabatan).trim() : null
      );
    catatLog(c, "tambah_guru", `${nama} (${username})`);
    return c.json({ ok: true, id: Number(gr.lastInsertRowid) });
  } catch {
    return c.json({ error: "Username sudah dipakai" }, 400);
  }
});

admin.put("/guru/:id", async (c) => {
  const id = c.req.param("id");
  const { nama, nip, is_bk, is_staf, jabatan, password } = await c.req.json();
  const cur = db.query("SELECT * FROM guru WHERE id = ?").get(id) as any;
  if (!cur) return c.json({ error: "Guru tidak ditemukan" }, 404);
  // Kata sandi: diisi = diganti (sama seperti menu Pengguna), kosong = tidak diganti.
  // Sebelum perbaikan ini password di sini diabaikan diam-diam, padahal form
  // menampilkan kolomnya — admin mengira sudah mengganti, padahal tidak.
  if (password && cur.user_id)
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(
      await Bun.password.hash(String(password)),
      cur.user_id
    );
  // jabatan wajib bila hasil akhirnya berstatus staf
  const stafAkhir = is_staf === undefined ? !!cur.is_staf : !!is_staf;
  const jabatanAkhir =
    jabatan === undefined ? cur.jabatan : String(jabatan || "").trim() || null;
  if (stafAkhir && !jabatanAkhir)
    return c.json({ error: "Jabatan wajib diisi bila Staff dicentang" }, 400);
  db.query(
    `UPDATE guru SET nama = COALESCE(?, nama), nip = ?,
     is_bk = COALESCE(?, is_bk),
     is_staf = COALESCE(?, is_staf), jabatan = ? WHERE id = ?`
  ).run(
    nama ?? null,
    nip ?? null,
    is_bk === undefined ? null : is_bk ? 1 : 0,
    is_staf === undefined ? null : is_staf ? 1 : 0,
    jabatanAkhir,
    id
  );
  catatLog(c, "ubah_guru", `id ${id}`);
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
  catatLog(c, "hapus_guru", `${g.nama}`);
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
  const gr = db.query("SELECT id FROM guru WHERE id = ?").get(id) as any;
  if (!gr) return c.json({ error: "Guru tidak ditemukan" }, 404);
  if (!Array.isArray(daftar))
    return c.json({ error: "daftar harus berupa array" }, 400);
  // Penugasan lama guru ini dikecualikan dari cek tingkat (grandfather):
  // nilai yang sudah terlanjur diinput lewat penugasan lama tidak boleh
  // terkunci hanya karena pengaturan tingkat berubah.
  const lamaSet = new Set(
    (
      db
        .query("SELECT mapel_id, kelas_id FROM guru_mapel WHERE guru_id = ?")
        .all(id) as any[]
    ).map((a) => `${a.mapel_id}:${a.kelas_id}`)
  );
  for (const d of daftar) {
    const m = db
      .query("SELECT id, nama, tingkat FROM mapel WHERE id = ?")
      .get(d.mapel_id) as any;
    const k = db
      .query("SELECT id, nama, tingkat FROM kelas WHERE id = ?")
      .get(d.kelas_id) as any;
    if (!m || !k)
      return c.json({ error: "mapel_id/kelas_id tidak valid" }, 400);
    if (
      !lamaSet.has(`${d.mapel_id}:${d.kelas_id}`) &&
      !mapelCocokTingkat(m.tingkat, k.tingkat)
    )
      return c.json(
        {
          error: `Mapel ${m.nama} hanya untuk kelas ${m.tingkat} — tidak bisa ditugaskan ke kelas ${k.nama} (tingkat ${k.tingkat ?? "-"}). Ubah dulu tingkat mapelnya di menu Mapel bila memang perlu.`,
        },
        400
      );
  }
  const ganti = db.transaction(() => {
    db.query("DELETE FROM guru_mapel WHERE guru_id = ?").run(id);
    const ins = db.query(
      "INSERT OR IGNORE INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?,?,?)"
    );
    for (const d of daftar) ins.run(id, d.mapel_id, d.kelas_id);
  });
  ganti();
  catatLog(c, "ubah_penugasan", `${daftar.length} penugasan`);
  return c.json({ ok: true, jumlah: daftar.length });
});

/* ============ IMPORT/EXPORT CSV GURU ============
 * Kolom: username,nama,nip,password,is_bk,is_staf,jabatan,mapel,kelas
 * - Dicocokkan via username: sudah ada → diperbarui, baru → dibuat
 * - password: kosong = tidak diubah (guru baru: default = username)
 * - is_bk/is_staf: 1/ya/yes/true/y (case-insensitive) = ya
 * - jabatan wajib bila is_staf = ya
 * - mapel: kode dipisah ";" ; kelas: nama dipisah ";" → cross product
 *   MENGGANTIKAN penugasan mengajar lama (hanya bila kolom mapel/kelas ada di file)
 * - guru BK (is_bk=1): kolom `kelas` = kelas yang ditangani untuk Catatan BK
 *   (disimpan di bk_kelas). Bila ia juga mengajar, isi kolom `mapel` seperti biasa
 *   (kode "BK" diabaikan — bukan mapel nilai) → dapat penugasan mengajar juga
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
      "",
      "MTK",
      "7A;7B",
    ]
      .map(csvField)
      .join(","),
  ];
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="template-guru.csv"');
  return c.body(bungkusCSV(lines));
});

admin.get("/guru/export", (c) => {
  const rows = db
    .query(
      `SELECT u.username, g.nama, g.nip, g.is_bk, g.is_staf, g.jabatan,
        (SELECT GROUP_CONCAT(kode, ';') FROM
           (SELECT DISTINCT m.kode AS kode FROM guru_mapel gm
            JOIN mapel m ON m.id = gm.mapel_id WHERE gm.guru_id = g.id)) AS mapel,
        CASE WHEN g.is_bk = 1
          THEN (SELECT GROUP_CONCAT(nama, ';') FROM
                  (SELECT DISTINCT k.nama AS nama FROM bk_kelas b
                   JOIN kelas k ON k.id = b.kelas_id WHERE b.guru_id = g.id))
          ELSE (SELECT GROUP_CONCAT(nama, ';') FROM
                  (SELECT DISTINCT k.nama AS nama FROM guru_mapel gm
                   JOIN kelas k ON k.id = gm.kelas_id WHERE gm.guru_id = g.id))
        END AS kelas
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
  return c.body(bungkusCSV(lines));
});

/** Export rekap mengajar: satu baris per (guru x mapel), tiap kelas di sel sendiri.
 *  Satu arah (bukan untuk import ulang). */
admin.get("/guru/export-mengajar", (c) => {
  const wali = new Map<number, string[]>();
  for (const r of db
    .query(
      "SELECT wali_guru_id AS gid, nama FROM kelas WHERE wali_guru_id IS NOT NULL ORDER BY tingkat, nama"
    )
    .all() as any[])
    wali.set(r.gid, [...(wali.get(r.gid) ?? []), r.nama]);

  const rows = db
    .query(
      `SELECT g.id AS gid, g.nama, g.is_bk, g.is_staf, g.jabatan,
              m.kode AS mapel, m.urutan, k.nama AS kelas
       FROM guru g
       LEFT JOIN guru_mapel gm ON gm.guru_id = g.id
       LEFT JOIN mapel m ON m.id = gm.mapel_id
       LEFT JOIN kelas k ON k.id = gm.kelas_id
       ORDER BY g.nama, m.urutan, k.tingkat, k.nama`
    )
    .all() as any[];

  const grup: {
    nama: string;
    peran: string;
    mapel: string;
    kelas: string[];
  }[] = [];
  const idx = new Map<string, number>();
  for (const r of rows) {
    const key = r.gid + "|" + (r.mapel ?? "");
    let gi = idx.get(key);
    if (gi === undefined) {
      const peran: string[] = [];
      if (r.is_bk) peran.push("BK");
      if (r.is_staf) peran.push("Staf" + (r.jabatan ? ": " + r.jabatan : ""));
      const wk = wali.get(r.gid);
      if (wk && wk.length) peran.push("Wali Kelas " + wk.join(", "));
      gi = grup.length;
      idx.set(key, gi);
      grup.push({
        nama: r.nama,
        peran: peran.join(" + ") || "-",
        mapel: r.mapel ?? "-",
        kelas: [],
      });
    }
    if (r.kelas) grup[gi].kelas.push(r.kelas);
  }

  const nMax = Math.max(1, ...grup.map((g) => g.kelas.length));
  const header = ["No", "Nama Guru", "Peran", "Mapel"];
  for (let i = 1; i <= nMax; i++) header.push("Kelas " + i);
  const lines = [header.join(",")];
  grup.forEach((g, i) => {
    const sel = [String(i + 1), g.nama, g.peran, g.mapel];
    for (let j = 0; j < nMax; j++) sel.push(g.kelas[j] ?? "");
    lines.push(sel.map(csvField).join(","));
  });

  catatLog(c, "export_rekap_mengajar", `${grup.length} baris`);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    'attachment; filename="rekap-mengajar-guru.csv"'
  );
  return c.body(bungkusCSV(lines));
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
    is_staf: boolean;
    jabatan: string | null;
    pasangan: Array<[string, string]>; // [kodeMapel, namaKelas]
    kelas: string[]; // nama kelas mentah (untuk guru BK → bk_kelas)
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
      is_staf,
      jabatan,
      pasangan: [],
      kelas: namaKelas,
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
      for (const k of b.kelas) if (!g.kelas.includes(k)) g.kelas.push(k);
      g.nos.push(no);
      // field lain ikut baris terakhir (boleh mengoreksi baris sebelumnya)
      g.nama = b.nama;
      g.nip = b.nip;
      g.is_bk = b.is_bk;
      g.is_staf = b.is_staf;
      g.jabatan = b.jabatan;
      if (b.pw) g.pw = b.pw;
    }
  }
  // --- Fase 2: proses tiap guru ---
  for (const g of grup.values()) {
    const label =
      g.nos.length > 1 ? `Baris ${g.nos.join(",")}` : `Baris ${g.nos[0]}`;
    const { username, nama, nip, pw, is_bk, is_staf } = g;
    const jabatan = g.jabatan;
    // validasi mapel & kelas dulu sebelum mengubah apa pun.
    // Guru BK: kolom `kelas` selalu menjadi kelas yang ditangani untuk Catatan BK
    // (bk_kelas). Bila ia juga mengajar mapel (kolom `mapel` diisi), dibuatkan pula
    // penugasan mengajar seperti guru biasa; kode "BK" diabaikan (bukan mapel nilai).
    let tugas: Array<[number, number]> | null = null; // guru_mapel
    let tugasBK: number[] | null = null; // bk_kelas (id kelas)
    if (adaKolomTugas) {
      const cacheK = new Map<string, number>();
      const cariKelas = (nk: string): number | null => {
        let kid = cacheK.get(nk.toLowerCase());
        if (kid === undefined) {
          const kk = db
            .query("SELECT id FROM kelas WHERE LOWER(nama) = LOWER(?)")
            .get(nk) as any;
          if (!kk) {
            gagal.push(`${label}: kelas "${nk}" tidak ditemukan`);
            return null;
          }
          kid = kk.id;
          cacheK.set(nk.toLowerCase(), kid);
        }
        return kid;
      };
      if (is_bk) {
        tugasBK = [];
        for (const nk of g.kelas) {
          const kid = cariKelas(nk);
          if (kid === null) {
            tugasBK = null;
            break;
          }
          if (!tugasBK.includes(kid)) tugasBK.push(kid);
        }
        if (tugasBK === null) continue;
      }
      tugas = [];
      const cacheM = new Map<string, any>();
      const cacheKT = new Map<number, any>();
      // Penugasan lama guru ini (bila sudah terdaftar) dikecualikan dari cek
      // tingkat — nilai yang sudah diinput tidak boleh terkunci oleh aturan baru.
      const exImpor = db
        .query(
          "SELECT g.id FROM guru g JOIN users u ON u.id = g.user_id WHERE u.username = ?"
        )
        .get(username) as any;
      const lamaImpor = new Set<string>(
        exImpor
          ? (
              db
                .query(
                  "SELECT mapel_id, kelas_id FROM guru_mapel WHERE guru_id = ?"
                )
                .all(exImpor.id) as any[]
            ).map((a) => `${a.mapel_id}:${a.kelas_id}`)
          : []
      );
      let batal = false;
      for (const [kd, nk] of g.pasangan) {
        if (is_bk && kd.toLowerCase() === "bk") continue; // BK bukan mapel nilai
        let mm = cacheM.get(kd.toLowerCase());
          if (mm === undefined) {
            mm = db
              .query("SELECT id, nama, tingkat FROM mapel WHERE LOWER(kode) = LOWER(?)")
              .get(kd) as any;
            if (!mm) {
              gagal.push(`${label}: kode mapel "${kd}" tidak ditemukan`);
              batal = true;
              break;
            }
            cacheM.set(kd.toLowerCase(), mm);
          }
          const kid = cariKelas(nk);
          if (kid === null) {
            batal = true;
            break;
          }
          // Mapel yang tidak berlaku di tingkat kelas ini: pasangan BARU
          // dilewati (dicatat sebagai peringatan), bukan menggagalkan baris.
          let kk = cacheKT.get(kid);
          if (kk === undefined) {
            kk = db
              .query("SELECT nama, tingkat FROM kelas WHERE id = ?")
              .get(kid) as any;
            cacheKT.set(kid, kk);
          }
          if (
            !lamaImpor.has(`${mm.id}:${kid}`) &&
            !mapelCocokTingkat(mm.tingkat, kk?.tingkat)
          ) {
            gagal.push(
              `${label}: pasangan ${mm.nama} × kelas ${nk} dilewati — mapel hanya untuk kelas ${mm.tingkat}`
            );
            continue;
          }
          tugas.push([mm.id, kid]);
        }
        if (batal) continue;
    }
    try {
      const ex = db
        .query(
          "SELECT g.id, g.user_id, g.nama, g.nip, g.is_bk, g.is_staf, g.jabatan FROM guru g JOIN users u ON u.id = g.user_id WHERE u.username = ?"
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
          !!ex.is_staf !== is_staf ||
          (ex.jabatan ?? null) !== fJabatan;
        if (pw) berubah = true; // password diisi = perubahan
        if (adaKolomTugas) {
          // penugasan mengajar (berlaku untuk semua, termasuk guru BK yang merangkap mengajar)
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
          // kelas BK (khusus guru BK)
          if (is_bk) {
            const baruBK = [...(tugasBK as number[])].sort((a, b) => a - b);
            const lamaBK = (
              db
                .query("SELECT kelas_id FROM bk_kelas WHERE guru_id = ? ORDER BY kelas_id")
                .all(ex.id) as any[]
            ).map((a) => a.kelas_id);
            if (JSON.stringify(lamaBK) !== JSON.stringify(baruBK)) berubah = true;
          }
        }
        if (!berubah) {
          diabaikan++;
          continue;
        }
        db.query(
          `UPDATE guru SET nama=?, nip=?, is_bk=?, is_staf=?, jabatan=? WHERE id=?`
        ).run(
          nama,
          nip,
          is_bk ? 1 : 0,
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
            "INSERT INTO guru (user_id, nama, nip, is_bk, is_staf, jabatan) VALUES (?,?,?,?,?,?)"
          )
          .run(
            Number(ur.lastInsertRowid),
            nama,
            nip,
            is_bk ? 1 : 0,
            is_staf ? 1 : 0,
            is_staf ? jabatan : null
          );
        gid = Number(gr.lastInsertRowid);
        dibuat++;
      }
      if (tugas !== null) {
        const daftar = tugas;
        const daftarBK = tugasBK; // null untuk guru biasa
        const ganti = db.transaction(() => {
          db.query("DELETE FROM guru_mapel WHERE guru_id = ?").run(gid);
          const ins = db.query(
            "INSERT OR IGNORE INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?,?,?)"
          );
          for (const [mid, kid] of daftar) ins.run(gid, mid, kid);
          db.query("DELETE FROM bk_kelas WHERE guru_id = ?").run(gid);
          if (daftarBK) {
            const insB = db.query(
              "INSERT OR IGNORE INTO bk_kelas (guru_id, kelas_id) VALUES (?,?)"
            );
            for (const kid of daftarBK) insB.run(gid, kid);
          }
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
  catatLog(c, "import_guru", `${sukses} baris (baru ${dibuat}, update ${diupdate})`);
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
    footer_baris1,
    footer_baris2,
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
    "footer_baris1 = COALESCE(?, footer_baris1)",
    "footer_baris2 = COALESCE(?, footer_baris2)",
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
    footer_baris1 ? String(footer_baris1).trim() || null : null,
    footer_baris2 ? String(footer_baris2).trim() || null : null,
  ];
  if (tglMode === "clear") sets.push("tanggal_raport = NULL");
  else if (tglMode === "set") {
    sets.push("tanggal_raport = ?");
    params.push(tglVal);
  }
  db.query(`UPDATE desain_raport SET ${sets.join(", ")} WHERE id = 1`).run(
    ...params
  );
  catatLog(c, "ubah_desain", "pengaturan raport");
  return c.json({ ok: true });
});

const KOP_DIR = "data/uploads";

function hapusKopLama() {
  let files: string[] = [];
  try {
    files = readdirSync(KOP_DIR);
  } catch {
    return; /* folder belum ada */
  }
  for (const f of files) {
    if (!/^kop[.-]/i.test(f)) continue;
    try {
      unlinkSync(`${KOP_DIR}/${f}`);
    } catch {
      /* abaikan */
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
  const nama = `kop-${Date.now()}.${ext}`; // unik per upload: cegah cache browser
  if (!existsSync(KOP_DIR)) mkdirSync(KOP_DIR, { recursive: true });
  hapusKopLama();
  await Bun.write(`${KOP_DIR}/${nama}`, f);
  const kop_path = `/uploads/${nama}`;
  db.query("UPDATE desain_raport SET kop_path = ? WHERE id = 1").run(kop_path);
  catatLog(c, "unggah_kop", kop_path);
  return c.json({ ok: true, kop_path });
});

/** Hapus gambar kop raport. */
admin.delete("/desain/kop", (c) => {
  hapusKopLama();
  db.query("UPDATE desain_raport SET kop_path = NULL WHERE id = 1").run();
  catatLog(c, "hapus_kop", undefined);
  return c.json({ ok: true });
});

/* ================= BACKUP & RESTORE ================= */

const BAGIAN_BACKUP = [
  "pengguna",
  "siswa",
  "kelas",
  "mapel",
  "penugasan",
  "rentang",
  "nilai",
  "catatan",
  "desain",
] as const;

const LABEL_BAGIAN: Record<string, string> = {
  pengguna: "Pengguna & Guru",
  siswa: "Siswa",
  kelas: "Kelas",
  mapel: "Mata Pelajaran",
  penugasan: "Penugasan Mengajar & BK",
  rentang: "Rentang Predikat",
  nilai: "Nilai",
  catatan: "Catatan & Kehadiran",
  desain: "Desain Raport",
};

/** Ambil isi satu bagian untuk file backup. */
function ambilBagian(nama: string): any {
  switch (nama) {
    case "pengguna":
      return {
        users: db
          .query(
            "SELECT id, username, password_hash, role, created_at FROM users ORDER BY id"
          )
          .all(),
        guru: db
          .query(
            "SELECT id, user_id, nama, nip, is_bk, is_staf FROM guru ORDER BY id"
          )
          .all(),
      };
    case "siswa":
      return db
        .query(
          "SELECT id, user_id, nis, nama, kelas_id, agama, jenis_kelamin FROM siswa ORDER BY id"
        )
        .all();
    case "kelas":
      return db
        .query(
          "SELECT id, nama, tingkat, wali_guru_id, tahun_ajaran, semester FROM kelas ORDER BY id"
        )
        .all();
    case "mapel":
      return db
        .query(
          "SELECT id, nama, kode, urutan, aktif, tingkat FROM mapel ORDER BY urutan, id"
        )
        .all();
    case "penugasan":
      return {
        guru_mapel: db
          .query("SELECT guru_id, mapel_id, kelas_id FROM guru_mapel")
          .all(),
        bk_kelas: db.query("SELECT guru_id, kelas_id FROM bk_kelas").all(),
      };
    case "rentang":
      return db
        .query(
          "SELECT id, mapel_id, guru_id, label, min_nilai, max_nilai FROM rentang_nilai ORDER BY id"
        )
        .all();
    case "nilai":
      return db
        .query(
          "SELECT siswa_id, mapel_id, tahun_ajaran, semester, nilai_angka, updated_by, updated_at FROM nilai"
        )
        .all();
    case "catatan":
      return db
        .query(
          `SELECT siswa_id, tahun_ajaran, semester, catatan_bk, catatan_wali,
                  catatan_guru, sakit, izin, alpa
           FROM catatan_raport`
        )
        .all();
    case "desain":
      return db.query("SELECT * FROM desain_raport WHERE id = 1").get();
    default:
      return null;
  }
}

/** Sinkronkan sqlite_sequence setelah restore ber-id eksplisit. */
function perbaikiSequence(tabel: string) {
  const r = db.query(`SELECT MAX(id) AS m FROM ${tabel}`).get() as any;
  db.query("DELETE FROM sqlite_sequence WHERE name = ?").run(tabel);
  if (r && r.m)
    db.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(tabel, r.m);
}

/** Tulis ulang satu bagian dari data backup (REPLACE, bukan gabung).
 *  Mengembalikan jumlah baris utama yang dipulihkan. */
const BAGIAN_ARRAY = new Set([
  "siswa",
  "kelas",
  "mapel",
  "rentang",
  "nilai",
  "catatan",
]);

function tulisBagian(nama: string, data: any): number {
  // array kosong valid: artinya pulihkan menjadi kosong
  if (BAGIAN_ARRAY.has(nama) && !Array.isArray(data))
    throw new Error(`Data bagian "${LABEL_BAGIAN[nama] ?? nama}" tidak valid`);
  let n = 0;
  switch (nama) {
    case "pengguna": {
      if (!Array.isArray(data.users) || !Array.isArray(data.guru))
        throw new Error('Bagian "Pengguna & Guru" tidak valid');
      db.exec("DELETE FROM guru");
      db.exec("DELETE FROM users");
      const iu = db.prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const u of data.users) {
        iu.run(u.id, u.username, u.password_hash, u.role, u.created_at ?? null);
        n++;
      }
      const ig = db.prepare(
        "INSERT INTO guru (id, user_id, nama, nip, is_bk, is_staf) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const g of data.guru)
        ig.run(g.id, g.user_id, g.nama, g.nip ?? null, g.is_bk ?? 0, g.is_staf ?? 0);
      perbaikiSequence("users");
      perbaikiSequence("guru");
      break;
    }
    case "siswa": {
      db.exec("DELETE FROM siswa");
      const q = db.prepare(
        "INSERT INTO siswa (id, user_id, nis, nama, kelas_id, agama, jenis_kelamin) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const r of data) {
        q.run(r.id, r.user_id ?? null, r.nis, r.nama, r.kelas_id, r.agama ?? null, r.jenis_kelamin ?? null);
        n++;
      }
      perbaikiSequence("siswa");
      break;
    }
    case "kelas": {
      db.exec("DELETE FROM kelas");
      const q = db.prepare(
        "INSERT INTO kelas (id, nama, tingkat, wali_guru_id, tahun_ajaran, semester) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const r of data) {
        q.run(r.id, r.nama, r.tingkat ?? null, r.wali_guru_id ?? null, r.tahun_ajaran ?? null, r.semester ?? null);
        n++;
      }
      perbaikiSequence("kelas");
      break;
    }
    case "mapel": {
      db.exec("DELETE FROM mapel");
      const q = db.prepare(
        "INSERT INTO mapel (id, nama, kode, urutan, aktif, tingkat) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const r of data) {
        // Backup lama belum punya kolom tingkat → pakai bawaan menurut kode.
        const tkt =
          normalisasiTingkat(r.tingkat) ?? tingkatDefaultKode(r.kode);
        q.run(r.id, r.nama, r.kode, r.urutan ?? null, r.aktif ?? 1, tkt);
        n++;
      }
      perbaikiSequence("mapel");
      break;
    }
    case "penugasan": {
      if (!Array.isArray(data.guru_mapel) || !Array.isArray(data.bk_kelas))
        throw new Error('Bagian "Penugasan" tidak valid');
      db.exec("DELETE FROM guru_mapel");
      db.exec("DELETE FROM bk_kelas");
      const q1 = db.prepare("INSERT INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?, ?, ?)");
      for (const r of data.guru_mapel) {
        q1.run(r.guru_id, r.mapel_id, r.kelas_id);
        n++;
      }
      const q2 = db.prepare("INSERT INTO bk_kelas (guru_id, kelas_id) VALUES (?, ?)");
      for (const r of data.bk_kelas) q2.run(r.guru_id, r.kelas_id);
      break;
    }
    case "rentang": {
      db.exec("DELETE FROM rentang_nilai");
      const q = db.prepare(
        "INSERT INTO rentang_nilai (id, mapel_id, guru_id, label, min_nilai, max_nilai) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const r of data) {
        q.run(r.id, r.mapel_id, r.guru_id, r.label, r.min_nilai, r.max_nilai);
        n++;
      }
      perbaikiSequence("rentang_nilai");
      break;
    }
    case "nilai": {
      db.exec("DELETE FROM nilai");
      const q = db.prepare(
        `INSERT INTO nilai (siswa_id, mapel_id, tahun_ajaran, semester, nilai_angka, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of data) {
        q.run(r.siswa_id, r.mapel_id, r.tahun_ajaran, r.semester, r.nilai_angka, r.updated_by ?? null, r.updated_at ?? null);
        n++;
      }
      break;
    }
    case "catatan": {
      db.exec("DELETE FROM catatan_raport");
      const q = db.prepare(
        `INSERT INTO catatan_raport (siswa_id, tahun_ajaran, semester, catatan_bk, catatan_wali,
          catatan_guru, sakit, izin, alpa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of data) {
        q.run(
          r.siswa_id, r.tahun_ajaran, r.semester,
          r.catatan_bk ?? null, r.catatan_wali ?? null,
          r.catatan_guru ?? null, r.sakit ?? 0, r.izin ?? 0, r.alpa ?? 0
        );
        n++;
      }
      break;
    }
    case "desain": {
      if (!data || typeof data !== "object")
        throw new Error('Bagian "Desain Raport" tidak valid');
      db.exec("DELETE FROM desain_raport");
      const q = db.prepare(
        `INSERT INTO desain_raport (id, kop_path, nama_sekolah, alamat_sekolah, kepala_nama,
          kepala_nip, kota, semester_aktif, tahun_ajaran_aktif,
          judul_raport, tempat, tanggal_raport, footer_baris1, footer_baris2)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // Backup lama belum punya judul/tempat/tanggal/footer → pakai bawaan
      // (sama dengan default di db.ts), bukan NULL yang mengosongkan judul.
      q.run(
        data.kop_path ?? null, data.nama_sekolah ?? null, data.alamat_sekolah ?? null,
        data.kepala_nama ?? null, data.kepala_nip ?? null, data.kota ?? null,
        data.semester_aktif ?? null, data.tahun_ajaran_aktif ?? null,
        data.judul_raport ? data.judul_raport : "LAPORAN HASIL BELAJAR PESERTA DIDIK",
        data.tempat ? data.tempat : "Punggur",
        data.tanggal_raport ? data.tanggal_raport : null,
        data.footer_baris1 ? data.footer_baris1 : "© 2026 GezyTech App · Dikembangkan oleh PakGun",
        data.footer_baris2 ? data.footer_baris2 : "GezyRaport — SMP Negeri 1 Punggur"
      );
      n = 1;
      break;
    }
    default:
      throw new Error(`Bagian tidak dikenal: ${nama}`);
  }
  return n;
}

/** Urutan restore yang aman terhadap relasi antar tabel. */
const URUTAN_RESTORE = [
  "desain",
  "mapel",
  "kelas",
  "pengguna",
  "siswa",
  "penugasan",
  "rentang",
  "nilai",
  "catatan",
];

/** Info jumlah baris per bagian (untuk halaman Backup). */
admin.get("/backup/info", (c) => {
  const hitung = (sql: string) => (db.query(sql).get() as any).n as number;
  return c.json({
    periode: periodeAktif(),
    bagian: BAGIAN_BACKUP.map((b) => ({ id: b, label: LABEL_BAGIAN[b] })),
    jumlah: {
      pengguna: hitung("SELECT COUNT(*) n FROM users"),
      siswa: hitung("SELECT COUNT(*) n FROM siswa"),
      kelas: hitung("SELECT COUNT(*) n FROM kelas"),
      mapel: hitung("SELECT COUNT(*) n FROM mapel"),
      penugasan:
        hitung("SELECT COUNT(*) n FROM guru_mapel") +
        hitung("SELECT COUNT(*) n FROM bk_kelas"),
      rentang: hitung("SELECT COUNT(*) n FROM rentang_nilai"),
      nilai: hitung("SELECT COUNT(*) n FROM nilai"),
      catatan: hitung("SELECT COUNT(*) n FROM catatan_raport"),
      desain: hitung("SELECT COUNT(*) n FROM desain_raport"),
    },
  });
});

/** Unduh file backup JSON. Query: ?bagian=pengguna,siswa,... (default: semua). */
admin.get("/backup", (c) => {
  const diminta = (c.req.query("bagian") || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => (BAGIAN_BACKUP as readonly string[]).includes(x));
  const daftar = diminta.length ? diminta : [...BAGIAN_BACKUP];
  const bagian: Record<string, any> = {};
  for (const b of daftar) bagian[b] = ambilBagian(b);
  const tgl = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="backup-gezyraport-${tgl}.json"`
  );
  catatLog(c, "unduh_backup", `bagian: ${daftar.join(", ")}`);
  return c.body(
    JSON.stringify(
      {
        gezyraport_backup: true,
        version: 1,
        dibuat: new Date().toISOString(),
        periode: periodeAktif(),
        bagian,
      },
      null,
      1
    )
  );
});

/** Restore dari file backup: REPLACE per bagian (atomic via transaksi). */
admin.post("/backup/restore", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body bukan JSON yang valid" }, 400);
  }
  if (!body?.gezyraport_backup || body.version !== 1 || !body.bagian)
    return c.json({ error: "File backup tidak valid" }, 400);
  const hasil: Record<string, number> = {};
  try {
    const jalan = db.transaction(() => {
      for (const b of URUTAN_RESTORE) {
        if (!(b in body.bagian)) continue;
        hasil[b] = tulisBagian(b, body.bagian[b]);
      }
    });
    jalan();
  } catch (e: any) {
    return c.json({ error: `Restore gagal: ${e.message}` }, 400);
  }
  if (!Object.keys(hasil).length)
    return c.json({ error: "Tidak ada bagian yang cocok untuk direstore" }, 400);
  catatLog(c, "restore_backup", `bagian: ${Object.keys(hasil).join(", ")}`);
  return c.json({ ok: true, hasil });
});

/* ================= LOG AKTIVITAS ================= */

/** Daftar log: filter ?q= ?aksi= ?dari=YYYY-MM-DD ?sampai=YYYY-MM-DD ?page= ?per= */
admin.get("/log", (c) => {
  const q = (c.req.query("q") || "").trim();
  const aksi = (c.req.query("aksi") || "").trim();
  const dari = (c.req.query("dari") || "").trim();
  const sampai = (c.req.query("sampai") || "").trim();
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const per = Math.min(100, Math.max(10, Number(c.req.query("per")) || 25));
  const where: string[] = [];
  const params: any[] = [];
  if (q) {
    where.push("(username LIKE ? OR detail LIKE ? OR aksi LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (aksi) {
    where.push("aksi = ?");
    params.push(aksi);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dari)) {
    where.push("waktu >= ?");
    params.push(dari + "T00:00:00");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(sampai)) {
    where.push("waktu <= ?");
    params.push(sampai + "T23:59:59");
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (
    db.query(`SELECT COUNT(*) AS n FROM activity_log ${w}`).get(...params) as any
  ).n as number;
  const rows = db
    .query(
      `SELECT id, waktu, username, peran, aksi, detail, ip
       FROM activity_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, per, (page - 1) * per);
  const daftarAksi = (
    db.query("SELECT DISTINCT aksi FROM activity_log ORDER BY aksi").all() as any[]
  ).map((r) => r.aksi);
  return c.json({ log: rows, total, page, per, daftarAksi });
});

/** Hapus log yang lebih lama dari N hari (minimal 30). */
admin.delete("/log/lama", async (c) => {
  let n = 0;
  try {
    n = Number((await c.req.json()).hari);
  } catch {
    return c.json({ error: "Body tidak valid" }, 400);
  }
  if (!Number.isInteger(n) || n < 30)
    return c.json({ error: "Minimal 30 hari" }, 400);
  const batas = new Date(Date.now() - n * 86400000).toISOString();
  const r = db.query("DELETE FROM activity_log WHERE waktu < ?").run(batas);
  const terhapus = Number(r.changes);
  catatLog(c, "hapus_log", `${terhapus} baris (> ${n} hari)`);
  return c.json({ ok: true, terhapus });
});

export default admin;
