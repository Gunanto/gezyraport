/* GezyRaport — utilitas bersama frontend */

const NAVS = {
  admin: [
    ["Beranda", "/"],
    ["Pengguna", "/users.html"],
    ["Guru", "/guru.html"],
    ["Kelas", "/kelas.html"],
    ["Siswa", "/siswa.html"],
    ["Mapel", "/mapel.html"],
  ],
  guru: [
    ["Beranda", "/"],
    ["Rentang Nilai", "/rentang.html"],
    ["Input Nilai", "/nilai.html"],
  ],
  siswa: [
    ["Beranda", "/"],
    ["Raport Saya", "/raport.html"],
  ],
};

const ROLE_NAMES = { admin: "Admin", guru: "Guru", siswa: "Siswa/Ortu" };

/** Escape HTML — cegah XSS saat render data ke halaman. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* bukan JSON */ }
  return { ok: res.ok, status: res.status, data };
}

function buildNav(role) {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const items = NAVS[role] || [];
  const here = location.pathname;
  nav.innerHTML = items
    .map(([label, href]) =>
      `<a href="${href}" class="${here === href || (href === "/" && here === "/index.html") ? "active" : ""}">${esc(label)}</a>`
    )
    .join("");
}

async function requireLogin(roles) {
  const r = await api("/api/me");
  if (!r.ok) {
    location.href = "/login.html";
    return null;
  }
  const user = r.data.user;
  if (roles && !roles.includes(user.role)) {
    location.href = "/";
    return null;
  }
  const info = document.getElementById("userInfo");
  if (info) {
    const nama = user.guru_nama || user.siswa_nama || user.username;
    info.textContent = `${nama} (${ROLE_NAMES[user.role] || user.role})`;
  }
  buildNav(user.role);
  const btn = document.getElementById("btnLogout");
  if (btn) btn.onclick = logout;
  return user;
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/login.html";
}

function showMsg(elId, text, kind = "error") {
  const el = document.getElementById(elId);
  if (!el) return;
  el.className = "alert " + kind;
  el.textContent = text;
  el.classList.remove("hidden");
}

function hideMsg(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.add("hidden");
}

async function confirmHapus(pesan) {
  return confirm(pesan || "Yakin ingin menghapus data ini?");
}
