# 🎓 GezyRaport

Aplikasi raport digital untuk **SMP Negeri 1 Punggur** — MVP Fase 1.

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

1. **Admin** login → isi **Guru** (nama + NIP + akun), **Kelas** (nama + wali kelas), **Siswa** (atau Import CSV), atur **Penugasan Mengajar** tiap guru (mapel × kelas). Cek **Mapel** (12 mapel bawaan, urutan bisa diubah).
2. **Guru** login → **Rentang Nilai**: tetapkan rentang predikat per mapel (atau pakai bawaan). → **Input Nilai**: pilih kelas + mapel, isi nilai 0–100 per siswa (atau Unduh Template CSV → isi di Excel → Import CSV).
3. **Siswa/Ortu** login → **Raport Saya** → **Cetak / Simpan PDF** (lewat dialog print browser).

Predikat dihitung otomatis dari rentang yang ditetapkan guru; bila guru belum menetapkan, dipakai bawaan: 0–69 Kurang/Remedial, 70–79 Tercapai/Cukup, 80–89 Baik, 90–100 Amat Baik/Pengayaan.

## Struktur folder

```
gezyraport/
├── server.ts        # entry point: auth, API routes, static files
├── db.ts            # koneksi sqlite + pembuatan skema
├── seed.ts          # data awal (12 mapel, desain, akun admin)
├── auth.ts          # session cookie + middleware requireRole
├── util.ts          # CSV, predikat, tanggal Indonesia, periode aktif
├── routes/
│   ├── admin.ts     # CRUD user/mapel/kelas/siswa/guru, import/export CSV
│   ├── guru.ts      # rentang nilai, input nilai, template/import CSV
│   └── raport.ts    # GET /api/raport (dengan guard peran)
├── public/
│   ├── css/style.css  (termasuk @media print untuk cetak raport)
│   ├── js/common.js   # nav, esc() anti-XSS, helper fetch
│   ├── login.html, index.html
│   ├── users.html, guru.html, kelas.html, siswa.html, mapel.html  (admin)
│   ├── rentang.html, nilai.html                                   (guru)
│   └── raport.html, cetak.html                                    (siswa/umum)
└── data/raport.db   # database sqlite (dibuat otomatis)
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

## Yang BELUM dikerjakan

**Fase 2** (input oleh peran terkait + desain cetak):
- Input catatan BK / wali kelas / ekstrakurikuler / guru
- Input kehadiran S/I/A
- Upload gambar kop raport
- CRUD desain raport (nama+NIP kepala sekolah, kota, periode aktif)

**Fase 3**:
- Arsip multi-semester
- Rekap/leger nilai per kelas
- Backup otomatis database
