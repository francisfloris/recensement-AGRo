/**
 * AgriRecensement – Serveur central
 * - Authentification des agents (jetons signés HMAC)
 * - Synchronisation hors ligne → en ligne (révisions incrémentales)
 * - Gestion des utilisateurs (admin / superviseur / agent)
 * - Page publique de vérification des cartes (QR code)
 */
const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TOKEN_DAYS = 30; // durée de session (les agents peuvent travailler hors ligne longtemps)

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "recensement.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','superviseur','agent')),
  agent_code TEXT UNIQUE NOT NULL,
  zone TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  token_version INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  must_change INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_sync TEXT
);
CREATE TABLE IF NOT EXISTS farmers(
  uid TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  agent_id INTEGER REFERENCES users(id),
  departement TEXT,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_farmers_rev ON farmers(rev);
CREATE INDEX IF NOT EXISTS idx_farmers_agent ON farmers(agent_id);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
`);

/* ---------- Paramètres & secret ---------- */
const getSetting = k => db.prepare("SELECT v FROM settings WHERE k=?").get(k)?.v;
const setSetting = (k, v) => db.prepare("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
if (!getSetting("secret")) setSetting("secret", crypto.randomBytes(48).toString("hex"));
if (!getSetting("org_name")) setSetting("org_name", "Ministère de l'Agriculture, de l'Élevage et de la Pêche");
if (!getSetting("campaign")) setSetting("campaign", "Campagne de recensement agricole " + new Date().getFullYear());
const SECRET = getSetting("secret");

/* ---------- Mots de passe ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, "hex"));
}

/* ---------- Administrateur par défaut ---------- */
if (!db.prepare("SELECT COUNT(*) n FROM users").get().n) {
  db.prepare(`INSERT INTO users(username,name,role,agent_code,pass_hash,must_change,created_at)
              VALUES('admin','Administrateur','admin','ADM',?,1,?)`).run(hashPassword("admin123"), new Date().toISOString());
  console.log("→ Compte administrateur créé : admin / admin123 (changement obligatoire à la 1re connexion)");
}

/* ---------- Jetons ---------- */
const b64 = s => Buffer.from(s).toString("base64url");
function signToken(user) {
  const payload = b64(JSON.stringify({ id: user.id, tv: user.token_version, exp: Date.now() + TOKEN_DAYS * 864e5 }));
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function verifyToken(tok) {
  if (!tok || !tok.includes(".")) return null;
  const [payload, sig] = tok.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, agentCode: u.agent_code, zone: u.zone, phone: u.phone, active: !!u.active, mustChange: !!u.must_change, lastSync: u.last_sync, createdAt: u.created_at });

/* ---------- Application ---------- */
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "25mb" }));

function auth(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
  const p = verifyToken(tok);
  if (!p) return res.status(401).json({ error: "Session expirée, veuillez vous reconnecter." });
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(p.id);
  if (!u || !u.active || u.token_version !== p.tv) return res.status(401).json({ error: "Compte désactivé ou session révoquée." });
  req.user = u;
  next();
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Accès refusé." });

/* Limitation simple des tentatives de connexion */
const attempts = new Map();
function rateLimited(key) {
  const now = Date.now(), a = attempts.get(key) || { n: 0, t: now };
  if (now - a.t > 15 * 60e3) { a.n = 0; a.t = now; }
  a.n++; attempts.set(key, a);
  return a.n > 10;
}

/* ---------- API : configuration publique ---------- */
app.get("/api/config", (req, res) => res.json({ orgName: getSetting("org_name"), campaign: getSetting("campaign") }));
app.put("/api/config", auth, requireRole("admin"), (req, res) => {
  const { orgName, campaign } = req.body || {};
  if (typeof orgName === "string" && orgName.trim()) setSetting("org_name", orgName.trim().slice(0, 120));
  if (typeof campaign === "string" && campaign.trim()) setSetting("campaign", campaign.trim().slice(0, 120));
  res.json({ orgName: getSetting("org_name"), campaign: getSetting("campaign") });
});

/* ---------- API : authentification ---------- */
app.post("/api/login", (req, res) => {
  const { username = "", password = "" } = req.body || {};
  if (rateLimited(req.ip + "|" + username.toLowerCase())) return res.status(429).json({ error: "Trop de tentatives. Réessayez dans 15 minutes." });
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(String(username).trim());
  if (!u || !checkPassword(String(password), u.pass_hash)) return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  if (!u.active) return res.status(403).json({ error: "Ce compte est désactivé. Contactez la coordination." });
  attempts.delete(req.ip + "|" + username.toLowerCase());
  res.json({ token: signToken(u), user: publicUser(u), lastSeq: lastSeq(u) });
});

function lastSeq(u) {
  return db.prepare("SELECT COALESCE(MAX(CAST(substr(code,-5) AS INTEGER)),0) n FROM farmers WHERE code LIKE ?").get(`AGR-${u.agent_code}-%`).n;
}

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user), lastSeq: lastSeq(req.user) }));

app.post("/api/me/password", auth, (req, res) => {
  const { current = "", next: nouveau = "" } = req.body || {};
  if (!checkPassword(String(current), req.user.pass_hash)) return res.status(400).json({ error: "Mot de passe actuel incorrect." });
  if (String(nouveau).length < 6) return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères." });
  db.prepare("UPDATE users SET pass_hash=?, must_change=0, token_version=token_version+1 WHERE id=?").run(hashPassword(nouveau), req.user.id);
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  res.json({ token: signToken(u), user: publicUser(u) });
});

/* ---------- API : utilisateurs (admin) ---------- */
app.get("/api/users", auth, requireRole("admin", "superviseur"), (req, res) => {
  const rows = db.prepare(`
    SELECT u.*, COUNT(f.uid) AS nb, MAX(f.updated_at) AS last_record
    FROM users u LEFT JOIN farmers f ON f.agent_id=u.id AND f.deleted=0
    GROUP BY u.id ORDER BY u.role, u.name`).all();
  res.json(rows.map(r => ({ ...publicUser(r), count: r.nb, lastRecord: r.last_record })));
});

function nextAgentCode() {
  const codes = db.prepare("SELECT agent_code FROM users WHERE agent_code GLOB 'A[0-9][0-9][0-9]'").all().map(r => +r.agent_code.slice(1));
  return "A" + String((codes.length ? Math.max(...codes) : 0) + 1).padStart(3, "0");
}

app.post("/api/users", auth, requireRole("admin"), (req, res) => {
  let { username, name, role = "agent", password, agentCode, zone = "", phone = "" } = req.body || {};
  username = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: "Identifiant invalide (3 à 30 caractères : lettres, chiffres, . _ -)." });
  if (!String(name || "").trim()) return res.status(400).json({ error: "Le nom est obligatoire." });
  if (!["admin", "superviseur", "agent"].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
  if (String(password || "").length < 6) return res.status(400).json({ error: "Mot de passe : 6 caractères minimum." });
  agentCode = String(agentCode || "").trim().toUpperCase() || nextAgentCode();
  if (!/^[A-Z0-9]{2,6}$/.test(agentCode)) return res.status(400).json({ error: "Code agent invalide (2 à 6 lettres/chiffres)." });
  try {
    const r = db.prepare(`INSERT INTO users(username,name,role,agent_code,zone,phone,pass_hash,must_change,created_at)
      VALUES(?,?,?,?,?,?,?,1,?)`).run(username, name.trim(), role, agentCode, zone.trim(), phone.trim(), hashPassword(password), new Date().toISOString());
    res.json(publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid)));
  } catch (e) {
    res.status(400).json({ error: e.message.includes("username") ? "Cet identifiant existe déjà." : "Ce code agent est déjà attribué." });
  }
});

app.put("/api/users/:id", auth, requireRole("admin"), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(+req.params.id);
  if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });
  const { name, role, active, password, zone, phone } = req.body || {};
  if (u.id === req.user.id && (active === false || (role && role !== "admin"))) return res.status(400).json({ error: "Vous ne pouvez pas vous désactiver ou retirer vos propres droits." });
  if (name !== undefined) db.prepare("UPDATE users SET name=? WHERE id=?").run(String(name).trim() || u.name, u.id);
  if (zone !== undefined) db.prepare("UPDATE users SET zone=? WHERE id=?").run(String(zone).trim(), u.id);
  if (phone !== undefined) db.prepare("UPDATE users SET phone=? WHERE id=?").run(String(phone).trim(), u.id);
  if (role && ["admin", "superviseur", "agent"].includes(role)) db.prepare("UPDATE users SET role=? WHERE id=?").run(role, u.id);
  if (active !== undefined) db.prepare("UPDATE users SET active=?, token_version=token_version+? WHERE id=?").run(active ? 1 : 0, active ? 0 : 1, u.id);
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: "Mot de passe : 6 caractères minimum." });
    db.prepare("UPDATE users SET pass_hash=?, must_change=1, token_version=token_version+1 WHERE id=?").run(hashPassword(password), u.id);
  }
  res.json(publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

/* ---------- API : synchronisation ---------- */
const UID_RE = /^[a-zA-Z0-9-]{8,48}$/;
const CODE_RE = /^AGR-[A-Z0-9]{2,6}-\d{5}$/;

function rowToRecord(r, names) {
  const d = JSON.parse(r.data);
  return { ...d, uid: r.uid, code: r.code, agentId: r.agent_id, agentName: names[r.agent_id] || d.agentName || "", updatedAt: r.updated_at, deleted: !!r.deleted, _rev: r.rev };
}

app.post("/api/sync", auth, (req, res) => {
  const user = req.user;
  const isAgent = user.role === "agent";
  const changes = Array.isArray(req.body?.changes) ? req.body.changes.slice(0, 500) : [];
  const since = Number.isFinite(+req.body?.since) ? +req.body.since : 0;
  const accepted = [], rejected = [], forced = new Set();

  const getByUid = db.prepare("SELECT * FROM farmers WHERE uid=?");
  const getByCode = db.prepare("SELECT uid FROM farmers WHERE code=?");
  const ins = db.prepare("INSERT INTO farmers(uid,code,agent_id,departement,data,updated_at,rev,deleted) VALUES(?,?,?,?,?,?,?,?)");
  const upd = db.prepare("UPDATE farmers SET departement=?, data=?, updated_at=?, rev=?, deleted=? WHERE uid=?");

  db.transaction(() => {
    let rev = db.prepare("SELECT COALESCE(MAX(rev),0) r FROM farmers").get().r;
    for (const c of changes) {
      if (!c || !UID_RE.test(c.uid || "") || !CODE_RE.test(c.code || "") || isNaN(Date.parse(c.updatedAt))) {
        rejected.push({ uid: c?.uid, reason: "Données invalides" }); continue;
      }
      const clean = { ...c }; delete clean._dirty; delete clean._rev;
      const json = JSON.stringify(clean);
      if (json.length > 400_000) { rejected.push({ uid: c.uid, reason: "Fiche trop volumineuse" }); continue; }
      const ex = getByUid.get(c.uid);
      if (ex) {
        if (isAgent && ex.agent_id !== user.id) { rejected.push({ uid: c.uid, reason: "Fiche d'un autre agent" }); forced.add(c.uid); continue; }
        if (ex.updated_at >= c.updatedAt) { accepted.push(c.uid); forced.add(c.uid); continue; } // version serveur plus récente
        upd.run(c.departement || "", json, c.updatedAt, ++rev, c.deleted ? 1 : 0, c.uid);
        accepted.push(c.uid);
      } else {
        if (isAgent && !c.code.startsWith(`AGR-${user.agent_code}-`)) { rejected.push({ uid: c.uid, reason: "Code agent non conforme" }); continue; }
        if (getByCode.get(c.code)) { rejected.push({ uid: c.uid, reason: `Le code ${c.code} existe déjà` }); continue; }
        ins.run(c.uid, c.code, user.id, c.departement || "", json, c.updatedAt, ++rev, c.deleted ? 1 : 0);
        accepted.push(c.uid);
      }
    }
  })();

  const names = Object.fromEntries(db.prepare("SELECT id,name FROM users").all().map(u => [u.id, u.name]));
  const scope = isAgent ? " AND agent_id=" + user.id : "";
  const rows = db.prepare(`SELECT * FROM farmers WHERE rev>?${scope} ORDER BY rev`).all(since);
  const seen = new Set(rows.map(r => r.uid));
  for (const uid of forced) if (!seen.has(uid)) { const r = getByUid.get(uid); if (r && (!isAgent || r.agent_id === user.id)) rows.push(r); }
  const maxRev = db.prepare(`SELECT COALESCE(MAX(rev),0) r FROM farmers WHERE 1=1${scope}`).get().r;

  db.prepare("UPDATE users SET last_sync=? WHERE id=?").run(new Date().toISOString(), user.id);
  res.json({ rev: Math.max(maxRev, since), records: rows.map(r => rowToRecord(r, names)), accepted, rejected, serverTime: new Date().toISOString() });
});

/* ---------- API : statistiques globales (admin / superviseur) ---------- */
app.get("/api/stats", auth, requireRole("admin", "superviseur"), (req, res) => {
  const total = db.prepare("SELECT COUNT(*) n FROM farmers WHERE deleted=0").get().n;
  const parDept = db.prepare("SELECT departement, COUNT(*) n FROM farmers WHERE deleted=0 GROUP BY departement ORDER BY n DESC").all();
  const parJour = db.prepare("SELECT substr(json_extract(data,'$.dateCreation'),1,10) jour, COUNT(*) n FROM farmers WHERE deleted=0 GROUP BY jour ORDER BY jour DESC LIMIT 30").all();
  res.json({ total, parDept, parJour });
});

/* ---------- Page publique de vérification (QR code) ---------- */
const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
app.get("/verifier/:code", (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const r = CODE_RE.test(code) ? db.prepare("SELECT * FROM farmers WHERE code=?").get(code) : null;
  const d = r ? JSON.parse(r.data) : null;
  const ok = r && !r.deleted;
  const agent = r ? db.prepare("SELECT name FROM users WHERE id=?").get(r.agent_id)?.name : "";
  const fdate = s => s ? new Date(s).toLocaleDateString("fr-FR") : "—";
  const ligne = (l, v) => `<div class="l"><span>${l}</span><b>${escHtml(v || "—")}</b></div>`;
  res.set("Cache-Control", "no-store").send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vérification ${escHtml(code)}</title>
<link rel="icon" href="/icons/favicon.png">
<style>
body{font-family:"Segoe UI",Roboto,Arial,sans-serif;background:#f5f7f4;margin:0;padding:20px;color:#1f2937}
.c{max-width:440px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08)}
.h{background:linear-gradient(135deg,#145a2d,#1f7a3f);color:#fff;padding:16px 20px;font-size:13px}
.h b{display:block;font-size:16px}
.st{padding:16px 20px;font-weight:700;font-size:17px;display:flex;align-items:center;gap:10px}
.ok{background:#e7f4ec;color:#145a2d}.ko{background:#fdecea;color:#b42318}
.p{padding:18px 20px;display:flex;gap:16px;align-items:center}
.p img,.p .av{width:86px;height:100px;border-radius:10px;object-fit:cover;background:#e7f4ec;display:grid;place-items:center;font-size:28px;font-weight:700;color:#145a2d}
.l{display:flex;justify-content:space-between;gap:10px;padding:9px 20px;border-top:1px solid #eef0ee;font-size:14px}
.l span{color:#6b7280}.l b{text-align:right}
.f{padding:14px 20px;font-size:12px;color:#6b7280;text-align:center}
</style></head><body><div class="c">
<div class="h"><b>${escHtml(getSetting("org_name"))}</b>${escHtml(getSetting("campaign"))}</div>
${ok ? `<div class="st ok">✅ Agriculteur recensé – carte valide</div>
<div class="p">${d.photo ? `<img src="${d.photo}" alt="">` : `<div class="av">${escHtml((d.prenom || "")[0] || "")}${escHtml((d.nom || "")[0] || "")}</div>`}
<div><div style="font-size:19px;font-weight:700">${escHtml((d.nom || "").toUpperCase())}</div><div style="font-size:16px">${escHtml(d.prenom)}</div>
<div style="margin-top:6px;font-family:monospace;background:#f2f4f2;padding:3px 8px;border-radius:6px;display:inline-block">${escHtml(r.code)}</div></div></div>
${ligne("Sexe", d.sexe)}${ligne("Département", d.departement)}${ligne("Localité", [d.village, d.district].filter(Boolean).join(", "))}
${ligne("Superficie", d.superficie ? d.superficie + " ha" : "")}${ligne("Cultures", (d.cultures || []).join(", "))}
${ligne("Coopérative", d.cooperative === "Oui" ? d.nomCooperative || "Oui" : d.cooperative)}
${ligne("Recensé le", fdate(d.dateCreation))}${ligne("Agent recenseur", agent)}`
    : `<div class="st ko">❌ ${r ? "Cette carte a été annulée" : "Aucun agriculteur ne correspond à ce code"}</div>
<div class="l"><span>Code vérifié</span><b>${escHtml(code)}</b></div>`}
<div class="f">Vérifié le ${new Date().toLocaleString("fr-FR")} · AgriRecensement</div>
</div></body></html>`);
});

/* ---------- Fichiers statiques (application PWA) ---------- */
app.use((req, res, next) => {
  if (req.path === "/sw.js" || req.path.endsWith(".webmanifest") || req.path === "/" || req.path.endsWith(".html")) res.set("Cache-Control", "no-cache");
  next();
});
app.get("/manifest.webmanifest", (req, res, next) => { res.type("application/manifest+json"); next(); });
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.use("/api", (req, res) => res.status(404).json({ error: "Route inconnue" }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, HOST, () => console.log(`AgriRecensement démarré sur http://${HOST}:${PORT}`));
