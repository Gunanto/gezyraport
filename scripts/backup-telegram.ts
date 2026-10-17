import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
const databasePath = process.env.GEZYRAPORT_DB_PATH?.trim() || "./data/raport.db";

if (!botToken || !chatId) {
  throw new Error("TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID wajib diisi");
}

function waktuJakarta(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jakarta",
    dateStyle: "short",
    timeStyle: "medium",
  })
    .format(new Date())
    .replace(/[^0-9]/g, "");
}

const stamp = waktuJakarta();
const filename = `gezyraport-${stamp}.db`;
const tempDir = await mkdtemp(join(tmpdir(), "gezyraport-backup-"));
const backupPath = join(tempDir, filename);

try {
  // serialize() mengambil snapshot SQLite yang konsisten, termasuk perubahan WAL.
  const source = new Database(databasePath, { readonly: true });
  const snapshot = source.serialize();
  source.close();
  await Bun.write(backupPath, snapshot);

  // Pastikan file yang akan dikirim dapat dibuka dan lolos integrity_check.
  const check = new Database(backupPath, { readonly: true });
  const integrity = (check.query("PRAGMA integrity_check").get() as { integrity_check: string })[
    "integrity_check"
  ];
  if (integrity !== "ok") throw new Error(`integrity_check gagal: ${integrity}`);
  check.close();

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append(
    "caption",
    `Backup GezyRaport\nWaktu WIB: ${stamp.slice(0, 8)} ${stamp.slice(8, 14)}\nUkuran: ${snapshot.length} byte`
  );
  form.append("document", Bun.file(backupPath), filename);

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const result = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram menolak backup: ${result?.description || `HTTP ${response.status}`}`);
  }

  console.log(JSON.stringify({ ok: true, filename, bytes: snapshot.length, chatId }));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
