import { Hono } from "hono";
import { db } from "../db";
import { requireRole } from "../auth";
import {
  periodeAktif,
  predikatUntuk,
  tanggalID,
  tanggalIDdariISO,
  validTanggalISO,
} from "../util";

const raport = new Hono();
raport.use(requireRole("admin", "guru", "siswa"));

function ambilSiswa(siswa_id: number) {
  return db
    .query(
      `SELECT s.id, s.nis, s.nama, s.agama, s.jenis_kelamin,
              k.id AS kelas_id, k.nama AS kelas, k.tingkat,
              k.wali_guru_id, g.nama AS wali_nama, g.nip AS wali_nip
       FROM siswa s
       LEFT JOIN kelas k ON k.id = s.kelas_id
       LEFT JOIN guru g ON g.id = k.wali_guru_id
       WHERE s.id = ?`
    )
    .get(siswa_id) as any;
}

/** Bangun objek data raport satu siswa (dipakai endpoint satuan & per kelas). */
function bangunRaport(sw: any) {
  const p = periodeAktif();
  const desain = db
    .query("SELECT * FROM desain_raport WHERE id = 1")
    .get() as any;

  // ---- Nilai per mapel aktif (BK bukan mapel nilai: tidak dimunculkan di raport) ----
  const mapelAktif = db
    .query(
      "SELECT id, nama FROM mapel WHERE aktif = 1 AND LOWER(kode) != 'bk' ORDER BY urutan, id"
    )
    .all() as any[];
  const rows = mapelAktif.map((m) => {
    const n = db
      .query(
        "SELECT nilai_angka FROM nilai WHERE siswa_id = ? AND mapel_id = ? AND tahun_ajaran = ? AND semester = ?"
      )
      .get(sw.id, m.id, p.tahun_ajaran, p.semester) as any;
    const nilai = n ? n.nilai_angka : null;
    return {
      mapel: m.nama,
      nilai,
      predikat: predikatUntuk(m.id, sw.kelas_id, nilai),
    };
  });

  // ---- Catatan & kehadiran ----
  const cat = db
    .query(
      "SELECT * FROM catatan_raport WHERE siswa_id = ? AND tahun_ajaran = ? AND semester = ?"
    )
    .get(sw.id, p.tahun_ajaran, p.semester) as any;

  // ---- Judul, tempat & tanggal (bisa diubah admin di menu Desain) ----
  const judul =
    (desain?.judul_raport || "").trim() || "LAPORAN HASIL BELAJAR PESERTA DIDIK";
  const tempat = (desain?.tempat || "").trim() || (desain?.kota || "").trim();
  const tglISO =
    desain?.tanggal_raport && validTanggalISO(desain.tanggal_raport)
      ? desain.tanggal_raport
      : null;
  const tanggalTeks = tglISO ? tanggalIDdariISO(tglISO) : tanggalID();

  return {
    identitas: {
      nama: sw.nama,
      nis: sw.nis,
      kelas: sw.kelas,
      tingkat: sw.tingkat,
      semester: p.semester,
      tahun_ajaran: p.tahun_ajaran,
      agama: sw.agama,
      jenis_kelamin: sw.jenis_kelamin,
    },
    rows,
    catatan: cat
      ? {
          bk: cat.catatan_bk,
          wali: cat.catatan_wali,
          ekskul: cat.catatan_ekskul,
        }
      : null,
    kehadiran: {
      sakit: cat?.sakit ?? 0,
      izin: cat?.izin ?? 0,
      alpa: cat?.alpa ?? 0,
    },
    ttd: {
      kepala_nama: desain?.kepala_nama || "",
      kepala_nip: desain?.kepala_nip || "",
      wali_nama: sw.wali_nama || "",
      wali_nip: sw.wali_nip || "",
      kota: desain?.kota || "",
      tanggal: tanggalID(),
      tempat,
      tanggal_teks: tanggalTeks,
    },
    sekolah: {
      nama: desain?.nama_sekolah || "",
      alamat: desain?.alamat_sekolah || "",
      kop: desain?.kop_path || null,
      judul,
    },
  };
}

/* ============ SATUAN ============ */
raport.get("/raport", (c) => {
  const u = c.get("user") as any;
  let siswa_id: any = c.req.query("siswa_id");

  // siswa/ortu tanpa parameter -> raport miliknya sendiri
  if (!siswa_id) {
    if (u.role !== "siswa")
      return c.json({ error: "Parameter siswa_id wajib diisi" }, 400);
    const own = db
      .query("SELECT id FROM siswa WHERE user_id = ?")
      .get(u.id) as any;
    if (!own) return c.json({ error: "Data siswa tidak ditemukan" }, 404);
    siswa_id = own.id;
  }

  const sw = ambilSiswa(Number(siswa_id));
  if (!sw) return c.json({ error: "Siswa tidak ditemukan" }, 404);

  // ---- Guard akses ----
  if (u.role === "siswa") {
    const own = db
      .query("SELECT id FROM siswa WHERE user_id = ?")
      .get(u.id) as any;
    if (!own || Number(siswa_id) !== own.id)
      return c.json({ error: "Akses ditolak" }, 403);
  } else if (u.role === "guru") {
    const g = db.query("SELECT id FROM guru WHERE user_id = ?").get(u.id) as any;
    if (!g) return c.json({ error: "Data guru tidak ditemukan" }, 404);
    const boleh = db
      .query(
        "SELECT 1 FROM guru_mapel WHERE guru_id = ? AND kelas_id = ? LIMIT 1"
      )
      .get(g.id, sw.kelas_id);
    if (!boleh)
      return c.json(
        { error: "Anda tidak mengajar di kelas siswa ini" },
        403
      );
  }

  return c.json(bangunRaport(sw));
});

/* ============ PER KELAS (admin & wali kelas) ============ */
raport.get("/raport/kelas/:kelas_id", (c) => {
  const u = c.get("user") as any;
  const kelas_id = Number(c.req.param("kelas_id"));
  if (!kelas_id) return c.json({ error: "kelas_id tidak valid" }, 400);

  if (u.role === "siswa")
    return c.json({ error: "Akses ditolak" }, 403);
  if (u.role === "guru") {
    const g = db.query("SELECT id FROM guru WHERE user_id = ?").get(u.id) as any;
    const wali = g
      ? db
          .query("SELECT 1 FROM kelas WHERE id = ? AND wali_guru_id = ?")
          .get(kelas_id, g.id)
      : null;
    if (!wali)
      return c.json(
        { error: "Hanya wali kelas yang dapat mencetak raport sekelas" },
        403
      );
  }

  const kelas = db.query("SELECT nama FROM kelas WHERE id = ?").get(kelas_id) as any;
  if (!kelas) return c.json({ error: "Kelas tidak ditemukan" }, 404);
  const daftar = db
    .query("SELECT id FROM siswa WHERE kelas_id = ? ORDER BY nama")
    .all(kelas_id) as any[];
  return c.json({
    kelas: kelas.nama,
    jumlah: daftar.length,
    raport: daftar.map((s) => bangunRaport(ambilSiswa(s.id))),
  });
});

export default raport;
