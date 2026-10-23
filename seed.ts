import { db } from "./db";

// [nama, kode, tingkat yang diampu] — Prakarya hanya 7 & 8, Seni Budaya hanya 9.
const MAPEL: Array<[string, string, string]> = [
  ["Pendidikan Agama Islam", "PAI", "7,8,9"],
  ["PPKn", "PKN", "7,8,9"],
  ["Bahasa Indonesia", "BIN", "7,8,9"],
  ["Matematika", "MTK", "7,8,9"],
  ["Ilmu Pengetahuan Alam", "IPA", "7,8,9"],
  ["Ilmu Pengetahuan Sosial", "IPS", "7,8,9"],
  ["Bahasa Inggris", "BING", "7,8,9"],
  ["Informatika", "INF", "7,8,9"],
  ["Seni Budaya", "SENI", "9"],
  ["Pendidikan Jasmani", "PJOK", "7,8,9"],
  ["Prakarya", "PRAK", "7,8"],
  ["Muatan Lokal", "MULOK", "7,8,9"],
];

let urutan = 1;
for (const [nama, kode, tingkat] of MAPEL) {
  db.query(
    "INSERT OR IGNORE INTO mapel (nama, kode, urutan, aktif, tingkat) VALUES (?,?,?,1,?)"
  ).run(nama, kode, urutan++, tingkat);
}
console.log(`OK: ${MAPEL.length} mapel tersedia.`);

db.query(
  `INSERT OR IGNORE INTO desain_raport
   (id, nama_sekolah, alamat_sekolah, kepala_nama, kepala_nip, kota, semester_aktif, tahun_ajaran_aktif)
   VALUES (1, 'SMP Negeri 1 Punggur', '', '', '', 'Punggur', 'Ganjil', '2026/2027')`
).run();
console.log("OK: desain_raport terisi (semester Ganjil 2026/2027).");

const adminAda = db.query("SELECT id FROM users WHERE username = 'admin'").get();
if (!adminAda) {
  const hash = await Bun.password.hash("admin123");
  db.query(
    "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,datetime('now'))"
  ).run("admin", hash, "admin");
  console.log("OK: user admin dibuat (username: admin, password: admin123).");
} else {
  console.log("OK: user admin sudah ada, dilewati.");
}

console.log("Seed selesai.");
