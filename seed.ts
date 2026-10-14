import { db } from "./db";

const MAPEL: Array<[string, string]> = [
  ["Pendidikan Agama Islam", "PAI"],
  ["PPKn", "PKN"],
  ["Bahasa Indonesia", "BIN"],
  ["Matematika", "MTK"],
  ["Ilmu Pengetahuan Alam", "IPA"],
  ["Ilmu Pengetahuan Sosial", "IPS"],
  ["Bahasa Inggris", "BING"],
  ["Informatika", "INF"],
  ["Seni Budaya", "SENI"],
  ["Pendidikan Jasmani", "PJOK"],
  ["Prakarya", "PRAK"],
  ["Muatan Lokal", "MULOK"],
];

let urutan = 1;
for (const [nama, kode] of MAPEL) {
  db.query(
    "INSERT OR IGNORE INTO mapel (nama, kode, urutan, aktif) VALUES (?,?,?,1)"
  ).run(nama, kode, urutan++);
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
