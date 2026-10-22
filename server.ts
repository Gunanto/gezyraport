import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie } from "hono/cookie";
import { db } from "./db";
import {
  createSession,
  destroySession,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
} from "./auth";
import { catatLog } from "./util";
import adminRoutes from "./routes/admin";
import guruRoutes from "./routes/guru";
import raportRoutes from "./routes/raport";
import catatanRoutes from "./routes/catatan";
import legerRoutes from "./routes/leger";

const app = new Hono();

// ---------- Auth ----------
app.post("/api/login", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body tidak valid" }, 400);
  }
  const { username, password } = body;
  if (!username || !password)
    return c.json({ error: "Username dan password wajib diisi" }, 400);
  const u = db
    .query("SELECT * FROM users WHERE username = ?")
    .get(username) as any;
  if (!u || !(await Bun.password.verify(password, u.password_hash))) {
    catatLog(c, "login_gagal", "username atau password salah", {
      username: String(username).slice(0, 64),
    });
    return c.json({ error: "Username atau password salah" }, 401);
  }
  const sid = createSession(u.id);
  setSessionCookie(c, sid);
  catatLog(c, "login", undefined, { id: u.id, username: u.username, role: u.role });
  return c.json({
    ok: true,
    user: { id: u.id, username: u.username, role: u.role },
  });
});

app.post("/api/logout", (c) => {
  const sid = getCookie(c, "sesi");
  const u = getSessionUser(c) as any;
  if (u) catatLog(c, "logout", undefined, { id: u.id, username: u.username, role: u.role });
  if (sid) destroySession(sid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  const u = getSessionUser(c);
  if (!u) return c.json({ error: "Belum login" }, 401);
  const guru = db
    .query(
      "SELECT id, nama, is_bk, is_staf, jabatan FROM guru WHERE user_id = ?"
    )
    .get(u.id) as any;
  const siswa = db
    .query("SELECT id, nama FROM siswa WHERE user_id = ?")
    .get(u.id) as any;
  let wali_kelas: any[] = [];
  let punya_ajar = false;
  if (guru) {
    wali_kelas = db
      .query("SELECT id, nama FROM kelas WHERE wali_guru_id = ? ORDER BY nama")
      .all(guru.id);
    punya_ajar = !!db
      .query("SELECT 1 FROM guru_mapel WHERE guru_id = ? LIMIT 1")
      .get(guru.id);
  }
  return c.json({
    user: {
      ...u,
      guru_id: guru?.id ?? null,
      guru_nama: guru?.nama ?? null,
      is_bk: !!guru?.is_bk,
      is_staf: !!guru?.is_staf,
      jabatan: guru?.jabatan ?? null,
      wali_kelas,
      kelas_wali: wali_kelas,
      punya_ajar,
      siswa_id: siswa?.id ?? null,
      siswa_nama: siswa?.nama ?? null,
    },
  });
});

// ---------- API routes ----------
app.route("/api/admin", adminRoutes);
app.route("/api/guru", guruRoutes);
app.route("/api/catatan", catatanRoutes);
app.route("/api/leger", legerRoutes);
app.route("/api", raportRoutes);

// ---------- File upload (kop raport dkk.) ----------
app.get("/uploads/*", async (c) => {
  const nama = c.req.path.replace(/^\/uploads\//, "");
  // hanya file gambar di root folder uploads, tanpa subdirektori
  if (
    !nama ||
    nama.includes("..") ||
    nama.includes("/") ||
    nama.includes("\\") ||
    !/\.(png|jpe?g)$/i.test(nama)
  )
    return c.json({ error: "Tidak ditemukan" }, 404);
  const f = Bun.file(`./data/uploads/${nama}`);
  if (!(await f.exists())) return c.json({ error: "Tidak ditemukan" }, 404);
  return new Response(f);
});

// ---------- Static frontend ----------
app.get("/", (c) => new Response(Bun.file("./public/index.html")));
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT || 3022);
console.log(`GezyRaport berjalan di http://localhost:${port}`);

export default { port, fetch: app.fetch };
