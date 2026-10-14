import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";

if (!existsSync("data")) mkdirSync("data", { recursive: true });
if (!existsSync("data/uploads")) mkdirSync("data/uploads", { recursive: true });

export const db = new Database("data/raport.db");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','guru','siswa')),
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS guru (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  nama TEXT NOT NULL,
  nip TEXT
);
CREATE TABLE IF NOT EXISTS kelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  tingkat TEXT,
  wali_guru_id INTEGER REFERENCES guru(id),
  tahun_ajaran TEXT,
  semester TEXT
);
CREATE TABLE IF NOT EXISTS siswa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  nis TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  kelas_id INTEGER REFERENCES kelas(id),
  agama TEXT,
  jenis_kelamin TEXT CHECK(jenis_kelamin IN ('L','P'))
);
CREATE TABLE IF NOT EXISTS mapel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  kode TEXT UNIQUE NOT NULL,
  urutan INTEGER,
  aktif INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS guru_mapel (
  guru_id INTEGER,
  mapel_id INTEGER,
  kelas_id INTEGER,
  PRIMARY KEY(guru_id,mapel_id,kelas_id)
);
CREATE TABLE IF NOT EXISTS bk_kelas (
  guru_id INTEGER,
  kelas_id INTEGER,
  PRIMARY KEY(guru_id,kelas_id)
);
CREATE TABLE IF NOT EXISTS rentang_nilai (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapel_id INTEGER NOT NULL,
  guru_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  min_nilai REAL NOT NULL,
  max_nilai REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS nilai (
  siswa_id INTEGER,
  mapel_id INTEGER,
  tahun_ajaran TEXT,
  semester TEXT,
  nilai_angka REAL,
  updated_by INTEGER,
  updated_at TEXT,
  PRIMARY KEY(siswa_id,mapel_id,tahun_ajaran,semester)
);
CREATE TABLE IF NOT EXISTS catatan_raport (
  siswa_id INTEGER,
  tahun_ajaran TEXT,
  semester TEXT,
  catatan_bk TEXT,
  catatan_wali TEXT,
  catatan_ekskul TEXT,
  catatan_guru TEXT,
  sakit INTEGER DEFAULT 0,
  izin INTEGER DEFAULT 0,
  alpa INTEGER DEFAULT 0,
  PRIMARY KEY(siswa_id,tahun_ajaran,semester)
);
CREATE TABLE IF NOT EXISTS desain_raport (
  id INTEGER PRIMARY KEY CHECK(id=1),
  kop_path TEXT,
  nama_sekolah TEXT,
  alamat_sekolah TEXT,
  kepala_nama TEXT,
  kepala_nip TEXT,
  kota TEXT,
  semester_aktif TEXT,
  tahun_ajaran_aktif TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

/* ---------- Migrasi non-destruktif Fase 2 ----------
   Kolom peran guru (is_bk, is_ekskul). Aman untuk DB lama:
   hanya ALTER bila kolom belum ada. */
function kolomAda(tabel: string, kolom: string): boolean {
  const info = db.query(`PRAGMA table_info(${tabel})`).all() as any[];
  return info.some((c) => c.name === kolom);
}
if (!kolomAda("guru", "is_bk"))
  db.exec("ALTER TABLE guru ADD COLUMN is_bk INTEGER DEFAULT 0");
if (!kolomAda("guru", "is_ekskul"))
  db.exec("ALTER TABLE guru ADD COLUMN is_ekskul INTEGER DEFAULT 0");

/* ---------- Migrasi non-destruktif: judul & tempat/tanggal raport ----------
   Admin bisa mengubah judul laporan serta tempat/tanggal terbit. */
if (!kolomAda("desain_raport", "judul_raport"))
  db.exec(
    "ALTER TABLE desain_raport ADD COLUMN judul_raport TEXT DEFAULT 'LAPORAN HASIL BELAJAR PESERTA DIDIK'"
  );
if (!kolomAda("desain_raport", "tempat"))
  db.exec("ALTER TABLE desain_raport ADD COLUMN tempat TEXT DEFAULT 'Punggur'");
if (!kolomAda("desain_raport", "tanggal_raport"))
  db.exec("ALTER TABLE desain_raport ADD COLUMN tanggal_raport TEXT");

/* ---------- Migrasi non-destruktif: staf (kepala sekolah, waka, dsb.) ---------- */
if (!kolomAda("guru", "is_staf"))
  db.exec("ALTER TABLE guru ADD COLUMN is_staf INTEGER DEFAULT 0");
if (!kolomAda("guru", "jabatan"))
  db.exec("ALTER TABLE guru ADD COLUMN jabatan TEXT");
