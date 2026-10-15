import { db } from "./db";

/** Rentang predikat bawaan bila guru belum menetapkan rentang sendiri. */
export const DEFAULT_RENTANG = [
  { label: "Amat Baik / Pengayaan", min_nilai: 90, max_nilai: 100 },
  { label: "Baik", min_nilai: 80, max_nilai: 89 },
  { label: "Tercapai / Cukup", min_nilai: 70, max_nilai: 79 },
  { label: "Kurang / Remedial", min_nilai: 0, max_nilai: 69 },
];

/** Periode aktif (semester + tahun ajaran) dari desain_raport. */
export function periodeAktif(): { semester: string; tahun_ajaran: string } {
  const d = db
    .query(
      "SELECT semester_aktif AS semester, tahun_ajaran_aktif AS tahun_ajaran FROM desain_raport WHERE id = 1"
    )
    .get() as any;
  return {
    semester: d?.semester ?? "Ganjil",
    tahun_ajaran: d?.tahun_ajaran ?? "2026/2027",
  };
}

/**
 * Tentukan predikat sebuah nilai untuk mapel + kelas tertentu.
 * Rentang diambil dari guru yang mengajar mapel itu di kelas tsb;
 * bila belum ada, pakai DEFAULT_RENTANG.
 */
export function predikatUntuk(
  mapel_id: number,
  kelas_id: number,
  nilai: number | null
): string | null {
  if (nilai === null || nilai === undefined || Number.isNaN(nilai)) return null;
  const gm = db
    .query(
      "SELECT guru_id FROM guru_mapel WHERE mapel_id = ? AND kelas_id = ? LIMIT 1"
    )
    .get(mapel_id, kelas_id) as any;
  let rows: any[] = [];
  if (gm) {
    rows = db
      .query(
        "SELECT label, min_nilai, max_nilai FROM rentang_nilai WHERE mapel_id = ? AND guru_id = ?"
      )
      .all(mapel_id, gm.guru_id);
  }
  if (!rows.length) rows = DEFAULT_RENTANG;
  const hit = rows.find((r) => nilai >= r.min_nilai && nilai <= r.max_nilai);
  return hit ? hit.label : null;
}

/** Parser CSV sederhana (mendukung field ber-quote). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch === "\r") {
        /* abaikan */
      } else {
        field += ch;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Escape satu field untuk output CSV. */
export function csvField(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Tulis NIS ke CSV agar aman dibuka di Excel: `="0146034471"` dibaca Excel
 *  sebagai teks sehingga nol di depan tidak hilang. */
export function nisExcel(nis: unknown): string {
  return `="${String(nis ?? "")}"`;
}

/** Kupas pembungkus formula Excel pada NIS dari file CSV
 *  (mis. `="0146034471"` hasil unduhan template → `0146034471`). */
export function normalisasiNIS(v: unknown): string {
  let s = String(v ?? "").trim();
  const m = s.match(/^="([\s\S]*)"$/);
  if (m) s = m[1].trim();
  return s;
}

/** Tanggal hari ini format Indonesia, mis. "14 Oktober 2026". */
export function tanggalID(d: Date = new Date()): string {
  const bulan = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
  ];
  return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()}`;
}

/** Validasi string tanggal format YYYY-MM-DD yang benar-benar ada di kalender. */
export function validTanggalISO(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  );
}

/** Format Indonesia dari string YYYY-MM-DD, mis. "2026-12-19" -> "19 Desember 2026". */
export function tanggalIDdariISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return tanggalID(new Date(y, m - 1, d));
}
