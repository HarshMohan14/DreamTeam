/* Dream Team server: Google sign-in, saved profiles, leaderboard and the live duel server. */
import express from "express";
import compression from "compression";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { OAuth2Client } from "google-auth-library";
import * as db from "./db.js";

const PORT = +process.env.PORT || 8787;
const PROD = process.env.NODE_ENV === "production";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const DEV_LOGIN = !PROD && process.env.DEV_LOGIN === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (PROD) { console.error("SESSION_SECRET must be set in production."); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[dev] SESSION_SECRET not set, using a random one (sign-ins reset on restart).");
}
if (!GOOGLE_CLIENT_ID) console.warn("GOOGLE_CLIENT_ID is not set: Google sign-in is switched off until you add it.");

const google = new OAuth2Client(GOOGLE_CLIENT_ID);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist");

/* ---------- sessions (signed cookie, no session store needed) ---------- */
const COOKIE = "dt_sess", MAX_AGE = 180 * 864e5;
const b64u = (s) => Buffer.from(s).toString("base64url");
const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeToken(uid) { const p = b64u(JSON.stringify({ uid, exp: Date.now() + MAX_AGE })); return `${p}.${sign(p)}`; }
function readToken(tok) {
  if (!tok || typeof tok !== "string") return null;
  const [p, s] = tok.split(".");
  if (!p || !s) return null;
  const good = sign(p);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o.uid : null; } catch { return null; }
}
function cookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const uidFromReq = (req) => readToken(cookies(req.headers.cookie)[COOKIE]);
function setSession(res, uid) {
  res.setHeader("Set-Cookie", `${COOKIE}=${makeToken(uid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE / 1000}${PROD ? "; Secure" : ""}`);
}
const publicUser = (u) => u && { id: u.id, name: u.name || "Player", picture: u.picture || null, email: u.email || null };

/* ---------- HTTP ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(compression());
app.use(express.json({ limit: "300kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  /* Google's sign-in popup needs this to talk back to the page. */
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null, devLogin: DEV_LOGIN }));

function signInUser(res, { sub, email, name, picture }) {
  const id = "u_" + crypto.createHash("sha256").update("dt|" + sub).digest("base64url").slice(0, 20);
  const u = db.upsertUser({ id, sub, email, name, picture });
  setSession(res, u.id);
  return u;
}

app.post("/api/auth/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: "Google sign-in isn't set up on this server yet." });
  try {
    const ticket = await google.verifyIdToken({ idToken: String(req.body?.credential || ""), audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub) throw new Error("no subject");
    const u = signInUser(res, { sub: p.sub, email: p.email, name: p.given_name || p.name, picture: p.picture });
    res.json({ user: publicUser(u), profile: db.getProfile(u.id) });
  } catch (e) {
    res.status(401).json({ error: "Google sign-in failed. Please try again." });
  }
});

/* Local testing only: sign in without Google. Never available when NODE_ENV=production. */
if (DEV_LOGIN) {
  app.post("/api/auth/dev", (req, res) => {
    const name = String(req.body?.name || "Tester").slice(0, 30);
    const u = signInUser(res, { sub: "dev:" + name.toLowerCase(), email: null, name, picture: null });
    res.json({ user: publicUser(u), profile: db.getProfile(u.id) });
  });
}

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? "; Secure" : ""}`);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const uid = uidFromReq(req), u = uid && db.userById(uid);
  if (!u) return res.json({ user: null });
  res.json({ user: publicUser(u), profile: db.getProfile(u.id) });
});

/* Save the player's game. Only dt_* keys, capped in size. */
app.put("/api/profile", (req, res) => {
  const uid = uidFromReq(req);
  if (!uid || !db.userById(uid)) return res.status(401).json({ error: "Not signed in" });
  const data = req.body?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return res.status(400).json({ error: "Bad profile" });
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^dt_[\w.-]{1,60}$/.test(k) || typeof v !== "string" || v.length > 120000) continue;
    clean[k] = v;
  }
  if (JSON.stringify(clean).length > 280000) return res.status(413).json({ error: "Profile too large" });
  res.json({ updated: db.putProfile(uid, clean) });
});

/* Static app (production build). Hashed assets cache for a year; the page and service worker never cache. */
if (fs.existsSync(DIST)) {
  app.use("/assets", express.static(path.join(DIST, "assets"), { immutable: true, maxAge: "365d" }));
  app.use(express.static(DIST, { index: false, setHeaders: (res, p) => { if (/sw\.js$|\.webmanifest$/.test(p)) res.setHeader("Cache-Control", "no-cache"); } }));
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(DIST, "index.html")); });
}

/* ---------- live server (Socket.IO) ---------- */
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64e3,
  pingInterval: 20000,
  pingTimeout: 20000,
  allowRequest: (req, cb) => {
    const o = req.headers.origin;
    if (!o) return cb(null, true);
    try { const h = new URL(o).host; cb(null, h === req.headers.host || ALLOWED_ORIGINS.includes(o)); } catch { cb(null, false); }
  },
});

/* peers: everyone with the game open. presence is what the game publishes (team, flag, invites, draft progress). */
const peers = new Map(); // socket.id -> { peer, by, guest, presence, user }
let peersTimer = null;
function broadcastPeers() {
  if (peersTimer) return;
  peersTimer = setTimeout(() => {
    peersTimer = null;
    const list = [...peers.values()].map((p) => ({ peer: p.peer, by: p.by, guest: p.guest, kind: "viewer", presence: p.presence }));
    io.to("lobby").emit("peers", list);
  }, 120);
}

/* simple per-socket rate limit */
function limiter(perWindow, ms) {
  let n = 0, t = Date.now();
  return () => { const now = Date.now(); if (now - t > ms) { n = 0; t = now; } return ++n <= perWindow; };
}

const OK_COLL = new Set(["lb", "duels"]);
const okId = (s) => typeof s === "string" && /^[\w-]{1,64}$/.test(s);
const size = (o) => JSON.stringify(o ?? null).length;

function validLb(d) {
  return d && typeof d.name === "string" && d.name.length <= 24 && Number.isFinite(d.best) && d.best >= 0 && d.best <= 100000 &&
    Number.isFinite(d.lv) && d.lv >= 1 && d.lv <= 20 && size(d.flag) <= 800 && size(d) <= 1500;
}
const DUEL_KEYS = new Set(["host", "guest", "hn", "hf", "fmt", "year", "seed", "ht", "gt", "st", "n", "ts"]);
function validDuel(d) {
  return d && Object.keys(d).every((k) => DUEL_KEYS.has(k)) && size(d) <= 8000 && (d.st == null || ["invited", "accepted", "drafting", "locked", "declined", "done"].includes(d.st));
}

/* live queries: each socket keeps its subscriptions; writes re-run the matching ones */
function runSub(sock, sid, s) {
  const rows = db.query(s.coll, s);
  sock.emit("db:snap", { sid, docs: rows });
}
function notifyColl(coll) {
  for (const [, sock] of io.of("/").sockets) {
    const subs = sock.data.subs;
    if (!subs) continue;
    for (const [sid, s] of subs) if (s.coll === coll) runSub(sock, sid, s);
  }
}

io.on("connection", (sock) => {
  const uid = uidFromReq(sock.request);
  const user = uid ? db.userById(uid) : null;
  const guestId = String(sock.handshake.auth?.guest || "").replace(/[^\w]/g, "").slice(0, 24) || sock.id.slice(0, 12);
  const by = user ? user.id : "g_" + guestId;
  sock.data.uid = user ? user.id : null;
  sock.data.subs = new Map();
  const canWrite = !!user;
  const writeOk = limiter(30, 10000), presOk = limiter(25, 5000), subOk = limiter(20, 10000);

  peers.set(sock.id, { peer: sock.id, by, guest: !user, presence: null });
  sock.join("lobby");
  sock.emit("hello", { peer: sock.id, by, signedIn: canWrite });
  broadcastPeers();

  sock.on("presence", (p) => {
    if (!presOk()) return;
    if (p != null && (typeof p !== "object" || size(p) > 4096)) return;
    const me = peers.get(sock.id);
    if (me) { me.presence = p; broadcastPeers(); }
  });

  sock.on("db:sub", (s, ack) => {
    if (!subOk() || !s || !okId(s.sid) || !OK_COLL.has(s.coll)) return ack?.({ error: "bad query" });
    const sub = { coll: s.coll, limit: Math.min(100, Math.max(1, +s.limit || 100)) };
    if (Array.isArray(s.where) && s.where.length === 3 && s.where[1] === "==") sub.where = [String(s.where[0]), "==", s.where[2]];
    if (Array.isArray(s.orderBy)) sub.orderBy = [String(s.orderBy[0]), s.orderBy[1] === "desc" ? "desc" : "asc"];
    /* duels are private: you can only list the ones you host or were invited to */
    if (sub.coll === "duels") {
      if (!sock.data.uid || !sub.where || !["host", "guest"].includes(sub.where[0]) || sub.where[2] !== sock.data.uid) return ack?.({ error: "denied" });
    }
    if (sock.data.subs.size > 20) return ack?.({ error: "too many" });
    sock.data.subs.set(s.sid, sub);
    ack?.({ ok: true });
    runSub(sock, s.sid, sub);
  });
  sock.on("db:unsub", (sid) => sock.data.subs.delete(sid));

  sock.on("db:write", (w, ack) => {
    const fail = (error) => ack?.({ error });
    if (!canWrite) return fail("sign-in required");
    if (!writeOk()) return fail("slow down");
    if (!w || !["set", "update"].includes(w.op) || typeof w.path !== "string" || !w.data || typeof w.data !== "object") return fail("bad write");
    const [coll, id, extra] = w.path.split("/");
    if (extra !== undefined || !OK_COLL.has(coll) || !okId(id)) return fail("bad path");
    const me = sock.data.uid, cur = db.readDoc(coll, id);

    if (coll === "lb") {
      if (id !== me) return fail("denied");
      const next = w.op === "update" ? { ...(cur || {}), ...w.data } : w.data;
      if (!validLb(next)) return fail("invalid");
      next.ts = Date.now();
      db.writeDoc(coll, id, next);
    } else {
      let next;
      if (cur) {
        if (cur.host !== me && cur.guest !== me) return fail("denied");
        next = w.op === "update" ? { ...cur, ...w.data } : w.data;
        if (next.host !== cur.host || next.guest !== cur.guest) return fail("denied");
      } else {
        if (w.op === "update") return fail("not found");
        next = w.data;
        if (next.host !== me || typeof next.guest !== "string" || next.guest === me || !/^u_/.test(next.guest)) return fail("denied");
      }
      if (!validDuel(next)) return fail("invalid");
      db.writeDoc(coll, id, next);
    }
    ack?.({ ok: true });
    notifyColl(coll);
  });

  sock.on("disconnect", () => { peers.delete(sock.id); broadcastPeers(); });
});

setInterval(() => { try { db.pruneOld(); } catch {} }, 864e5).unref();

server.listen(PORT, () => console.log(`Dream Team server on http://localhost:${PORT}${fs.existsSync(DIST) ? "" : " (API only: run the Vite dev server for the app)"}`));
