# 🎓 GezyRaport

Aplikasi raport digital untuk **SMP Negeri 1 Punggur** — Fase 1 (MVP) + Fase 2 selesai.

Stack: **Bun + Hono + bun:sqlite** (mode WAL), satu proses. Frontend: HTML + CSS + JS vanilla (tanpa framework, tanpa CDN), diserve langsung oleh Hono dari `./public`.

## Cara menjalankan

```bash
cd gezyraport
bun install
bun run seed     # buat tabel + isi 12 mapel + akun admin (sekali saja)
bun run start    # jalan di http://localhost:3022 (atau PORT dari env)
```

| Perintah        | Kegunaan                              |
|----------------|---------------------------------------|
| `bun install`  | install dependensi (hono)             |
| `bun run seed` | inisialisasi database + data awal    |
| `bun run start`| jalankan server (default port 3022)  |

## Akun default

- Username: `admin` — Password: `admin123`

> ⚠️ **WAJIB diganti setelah deploy** (login → Pengguna → Ubah akun admin).

Akun siswa dibuat otomatis: username & password = **NIS**.

## Alur pakai (Fase 1)

1. **Admin** login → isi **Guru** (nama + NIP + akun, atau Import CSV sinkronisasi), **Kelas** (nama + wali kelas), **Siswa** (atau Import CSV sinkronisasi via NIS), atur **Penugasan Mengajar** tiap guru (mapel × kelas, atau via kolom `mapel`/`kelas` di CSV guru). Cek **Mapel** (12 mapel bawaan, urutan bisa diubah).
2. **Guru** login → **Rentang Nilai**: tetapkan rentang predikat per mapel (atau pakai bawaan). → **Input Nilai**: pilih kelas + mapel, isi nilai 0–100 per siswa (atau Unduh Template CSV → isi di Excel → Import CSV).
3. **Siswa/Ortu** login → **Raport Saya** → **Cetak / Simpan PDF** (lewat dialog print browser).

Predikat dihitung otomatis dari rentang yang ditetapkan guru; bila guru belum menetapkan, dipakai bawaan: 0–69 Kurang/Remedial, 70–79 Tercapai/Cukup, 80–89 Baik, 90–100 Amat Baik/Pengayaan.

## Alur pakai (Fase 2)

4. **Admin** → **Guru**: centang **Guru BK** / **Pembina Ekskul** bila perlu; → **Desain Raport**: isi nama sekolah, kepala sekolah + NIP, kota, periode aktif; upload gambar kop raport (PNG/JPEG ≤ 2 MB).
5. **Wali kelas** → **Catatan Wali Kelas**: isi catatan + kehadiran S/I/A per siswa (bisa lewat form atau template/import CSV).
6. **Guru BK** → **Catatan BK** | **Pembina ekskul** → **Catatan Ekskul** | **Guru mapel** → **Catatan Guru** — masing-masing per kelas (form atau CSV).
7. Menu di beranda menyesuaikan peran guru yang login (wali/BK/ekskul/pengajar).

**Beranda admin** menampilkan card rekap (jumlah guru, siswa, kelas, mapel aktif) yang diambil langsung dari database — tiap card bisa diklik menuju halamannya. Tabel **Siswa** memakai pagination 25 baris per halaman agar ringan dibuka.

**Cetak raport**: per siswa via `cetak.html?siswa=ID`, atau **sekaligus sekelas** via menu **Cetak per Kelas** (`cetak-kelas.html`) — admin memilih kelas mana saja, wali kelas otomatis kelasnya sendiri; tiap siswa ganti halaman saat diprint. Blok tanda tangan raport: 3 kolom sejajar — Orang Tua/Wali, Wali Kelas, Kepala Sekolah.

Catatan dev: link CSS memakai `?v=...` (cache-busting) — setiap mengubah `public/css/style.css`, naikkan versinya di semua halaman agar browser pengunjung memuat CSS baru.

### Format CSV catatan (import/export)

Kolom `nama` hanya referensi; pencocokan saat import memakai `nis` (harus siswa di kelas yang dipilih). Hanya kolom milik fitur itu yang diupdate:

| Fitur | Kolom CSV |
|---|---|
| BK | `nis,nama,catatan_bk` |
| Wali kelas | `nis,nama,catatan_wali,sakit,izin,alpa` |
| Ekskul | `nis,nama,catatan_ekskul` |
| Guru mapel | `nis,nama,catatan_guru` |

Template CSV terisi data yang sudah tersimpan (sekaligus export). Saat import: teks kosong = hapus catatan; angka kehadiran kosong = pertahankan nilai lama; `sakit/izin/alpa` harus angka bulat ≥ 0. Baris gagal dilaporkan per baris beserta alasannya.

### Format CSV guru (import/export, halaman Kelola Guru)

Kolom: `username,nama,nip,password,is_bk,is_ekskul,is_staf,jabatan,mapel,kelas`

- Import bersifat **sinkronisasi** via `username`: belum ada → ditambah, berubah → diperbarui, **sama persis → diabaikan** (tidak dihitung sebagai update).
- `password`: kosong = tidak diubah (guru baru: default = username). Isi untuk mereset password (dianggap perubahan).
- `is_bk`/`is_ekskul`/`is_staf`: `1`/`ya`/`yes`/`true`/`y` (tak peduli kapital) = ya.
- `jabatan`: wajib diisi bila `is_staf` = ya (mis. `Kepala Sekolah`, `Waka Kurikulum`).
- `mapel`: kode mapel dipisah `;` (mis. `MTK;IPA`); `kelas`: nama kelas dipisah `;` (mis. `7A;7B`). Bila kedua kolom ada di file, kombinasinya **menggantikan** penugasan mengajar guru tersebut (kosong = hapus semua penugasan). Kode/nama yang tidak dikenal membuat baris itu gagal.

## Struktur folder

```
gezyraport/
├── server.ts        # entry point: auth, API routes, static files
├── db.ts            # koneksi sqlite + pembuatan skema
├── seed.ts          # data awal (12 mapel, desain, akun admin)
├── auth.ts          # session cookie + middleware requireRole
├── util.ts          # CSV, predikat, tanggal Indonesia, periode aktif
├── routes/
│   ├── admin.ts     # CRUD user/mapel/kelas/siswa/guru, import/export CSV, desain + kop
│   ├── guru.ts      # rentang nilai, input nilai, template/import CSV
│   ├── catatan.ts   # catatan wali/BK/ekskul/guru + template/import CSV (guard peran)
│   └── raport.ts    # GET /api/raport (dengan guard peran)
├── public/
│   ├── css/style.css  (termasuk @media print untuk cetak raport)
│   ├── js/common.js   # nav dinamis per peran, esc() anti-XSS, helper fetch
│   ├── login.html, index.html
│   ├── users.html, guru.html, kelas.html, siswa.html, mapel.html, desain.html (admin)
│   ├── rentang.html, nilai.html, wali.html, bk.html, ekskul.html,
│   │   catatan-guru.html                                         (guru)
│   └── raport.html, cetak.html                                   (siswa/umum)
├── data/
│   ├── raport.db    # database sqlite (dibuat otomatis)
│   └── uploads/     # gambar kop raport (kop.png / kop.jpg)
```

## Deploy VPS (contoh systemd)

```ini
[Unit]
Description=GezyRaport
After=network.target

[Service]
WorkingDirectory=/opt/gezyraport
ExecStart=/root/.bun/bin/bun server.ts
Environment=PORT=3022
Restart=always

[Install]
WantedBy=multi-user.target
```

Lalu: `systemctl enable --now gezyraport`. Backup cukup dengan menyalin `data/raport.db`.

## Judul & tempat/tanggal raport (bisa diubah admin)

**Admin** → **Desain Raport**: **Judul Laporan** (mis. `LAPORAN HASIL ASESMEN SUMATIF TENGAH SEMESTER GANJIL`), **Tempat**, dan **Tanggal** (kosongkan = pakai tanggal hari ini). Judul dan baris `Tempat, Tanggal` di halaman cetak mengikuti isian ini.

## Leger nilai per kelas

**Admin** → **Guru**: centang **Staff** + isi **Jabatan** (mis. Kepala Sekolah, Waka Kurikulum) untuk memberi akses leger penuh. Menu **Leger Nilai** muncul untuk admin, staf, dan wali kelas (wali hanya kelasnya sendiri).

Halaman leger menampilkan matriks No/NIS/Nama × 12 mapel + rata-rata (predikat otomatis, sel diwarnai), dengan tombol **Export CSV** (`nis,nama,<kode mapel>,rata2`) dan **Cetak** (landscape).

## Yang BELUM dikerjakan

**Fase 3**:
- Arsip multi-semester
- Backup otomatis database
