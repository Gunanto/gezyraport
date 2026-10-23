import { Hono } from "hono";
import { db } from "../db";
import { requireRole } from "../auth";
import { periodeAktif, predikatUntuk, mapelCocokTingkat, csvField, bungkusCSV } from "../util";

/**
 * Leger nilai per kelas — matriks nilai seluruh siswa satu kelas.
 * Akses: admin & staf (kepala sekolah, waka, dsb.) boleh semua kelas;
 * wali kelas hanya kelas yang diawalinya; guru biasa & siswa ditolak (403).
 */
const leger = new Hono();
leger.use(requireRole("admin", "guru", "siswa"));

interface Akses {
  role: string;
  is_staf: boolean;
  waliKelas: number[];
}

/** Hak akses leger pemohon. */
function akses(c: any): Akses {
  const u = c.get("user") as any;
  if (u.role !== "guru") return { role: u.role, is_staf: false, waliKelas: [] };
  const g = db
    .query("SELECT id, is_staf FROM guru WHERE user_id = ?")
    .get(u.id) as any;
  const waliKelas = g
    ? (
        db
          .query("SELECT id FROM kelas WHERE wali_guru_id = ?")
          .all(g.id) as any[]
      ).map((k) => Number(k.id))
    : [];
  return { role: u.role, is_staf: !!g?.is_staf, waliKelas };
}

/**
 * Daftar id kelas yang boleh dilihat pemohon.
 * null = semua kelas; [] = tidak ada.
 */
function kelasBoleh(a: Akses): number[] | null {
  if (a.role === "admin" || a.is_staf) return null;
  if (a.role === "guru") return a.waliKelas;
  return [];
}

function bolehKelas(a: Akses, kelas_id: number): boolean {
  const b = kelasBoleh(a);
  return b === null || b.includes(kelas_id);
}

function daftarKelas(ids: number[] | null): any[] {
  if (ids === null)
    return db
      .query("SELECT id, nama, tingkat FROM kelas ORDER BY tingkat, nama")
      .all();
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return db
    .query(
      `SELECT id, nama, tingkat FROM kelas WHERE id IN (${ph}) ORDER BY tingkat, nama`
    )
    .all(...ids);
}

/** GET /api/leger/kelas — daftar kelas yang boleh diakses pemohon. */
leger.get("/kelas", (c) => {
  return c.json({ kelas: daftarKelas(kelasBoleh(akses(c))) });
});

interface NilaiSel {
  angka: number | null;
  predikat: string | null;
}

/** Susun matriks leger satu kelas untuk periode aktif. */
function bangunLeger(kelas_id: number) {
  const p = periodeAktif();
  const kelas = db
    .query("SELECT id, nama, tingkat FROM kelas WHERE id = ?")
    .get(kelas_id) as any;
  // Kolom leger hanya mapel yang berlaku untuk tingkat kelas ini
  // (mis. kelas 7/8 tanpa Seni Budaya, kelas 9 tanpa Prakarya).
  const mapel = (
    db
      .query(
        "SELECT id, kode, nama, tingkat FROM mapel WHERE aktif = 1 AND LOWER(kode) != 'bk' ORDER BY urutan, id"
      )
      .all() as any[]
  ).filter((m) => mapelCocokTingkat(m.tingkat, kelas.tingkat));
  const siswa = db
    .query("SELECT id, nis, nama FROM siswa WHERE kelas_id = ? ORDER BY nama")
    .all(kelas_id) as any[];
  const qNilai = db.query(
    "SELECT nilai_angka FROM nilai WHERE siswa_id = ? AND mapel_id = ? AND tahun_ajaran = ? AND semester = ?"
  );
  const dataSiswa = siswa.map((s) => {
    const nilai: Record<string, NilaiSel> = {};
    let jml = 0;
    let total = 0;
    for (const m of mapel) {
      const n = qNilai.get(s.id, m.id, p.tahun_ajaran, p.semester) as any;
      const angka = n ? Number(n.nilai_angka) : null;
      nilai[m.id] = { angka, predikat: predikatUntuk(m.id, kelas_id, angka) };
      if (angka !== null) {
        jml++;
        total += angka;
      }
    }
    const rata2 = jml ? Math.round((total / jml) * 10) / 10 : null;
    return { id: s.id, nis: s.nis, nama: s.nama, nilai, rata2 };
  });
  // Nilai rata-rata sama mendapat peringkat sama; peringkat berikutnya tetap berurutan.
  const urutRanking = dataSiswa
    .filter((s) => s.rata2 !== null)
    .sort((a, b) => b.rata2! - a.rata2! || a.nama.localeCompare(b.nama, "id"));
  const ranking = new Map<number, number>();
  let peringkat = 0;
  let rata2Sebelumnya: number | null = null;
  for (const s of urutRanking) {
    if (rata2Sebelumnya === null || s.rata2 !== rata2Sebelumnya) {
      peringkat++;
      rata2Sebelumnya = s.rata2;
    }
    ranking.set(s.id, peringkat);
  }
  return {
    kelas: { id: kelas.id, nama: kelas.nama },
    periode: p,
    mapel: mapel.map((m) => ({ id: m.id, kode: m.kode, nama: m.nama })),
    siswa: dataSiswa.map((s) => ({ ...s, ranking: ranking.get(s.id) ?? null })),
  };
}

/** Guard umum: kelas ada + pemohon berhak. Kembalikan {ok, kelas_id} atau response error. */
function guardKelas(c: any): { kelas_id: number } | Response {
  const kelas_id = Number(c.req.query("kelas_id"));
  if (!kelas_id) return c.json({ error: "kelas_id wajib diisi" }, 400);
  const ada = db.query("SELECT id FROM kelas WHERE id = ?").get(kelas_id);
  if (!ada) return c.json({ error: "Kelas tidak ditemukan" }, 404);
  if (!bolehKelas(akses(c), kelas_id))
    return c.json({ error: "Akses ditolak" }, 403);
  return { kelas_id };
}

/** GET /api/leger?kelas_id= — matriks leger JSON. */
leger.get("/", (c) => {
  const g = guardKelas(c);
  if (g instanceof Response) return g;
  return c.json(bangunLeger(g.kelas_id));
});

/** GET /api/leger/export?kelas_id= — CSV ber-BOM. */
leger.get("/export", (c) => {
  const g = guardKelas(c);
  if (g instanceof Response) return g;
  const leg = bangunLeger(g.kelas_id);
  const header = ["nis", "nama", ...leg.mapel.map((m) => m.kode), "rata2", "ranking"];
  const lines = [header.join(",")];
  for (const s of leg.siswa) {
    const vals: (string | number)[] = [s.nis, s.nama];
    for (const m of leg.mapel) {
      const v = s.nilai[m.id]?.angka;
      vals.push(v === null || v === undefined ? "" : v);
    }
    vals.push(s.rata2 === null ? "" : s.rata2);
    vals.push(s.ranking === null ? "" : s.ranking);
    lines.push(vals.map(csvField).join(","));
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="leger-${leg.kelas.nama}.csv"`
  );
  return c.body(bungkusCSV(lines));
});

export default leger;
