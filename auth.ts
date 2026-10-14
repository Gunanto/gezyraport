import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db } from "./db";

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

const SESSION_DAYS = 7;

export function createSession(userId: number): string {
  const id = crypto.randomUUID();
  const expires_at = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)").run(
    id,
    userId,
    expires_at
  );
  return id;
}

export function destroySession(id: string): void {
  db.query("DELETE FROM sessions WHERE id = ?").run(id);
}

export function getSessionUser(c: Context): SessionUser | null {
  const sid = getCookie(c, "sesi");
  if (!sid) return null;
  const s = db
    .query(
      `SELECT s.user_id, s.expires_at, u.username, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(sid) as any;
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    destroySession(sid);
    return null;
  }
  return { id: s.user_id, username: s.username, role: s.role };
}

export function setSessionCookie(c: Context, sid: string): void {
  setCookie(c, "sesi", sid, {
    httpOnly: true,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
    sameSite: "Lax",
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, "sesi", { path: "/" });
}

/** Middleware: user harus login dan role-nya termasuk salah satu yang diizinkan. */
export function requireRole(...roles: string[]) {
  return async (c: Context, next: Next) => {
    const u = getSessionUser(c);
    if (!u) return c.json({ error: "Belum login" }, 401);
    if (!roles.includes(u.role)) return c.json({ error: "Akses ditolak" }, 403);
    c.set("user", u);
    await next();
  };
}
