/* Storage: one SQLite file (built into Node 22, no native modules to compile). */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const file = process.env.DB_PATH || "./data/dream-team.db";
if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
export const sql = new DatabaseSync(file);

sql.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- public, opaque player id (never the Google id or email)
  sub TEXT UNIQUE NOT NULL,      -- Google account id
  email TEXT, name TEXT, picture TEXT,
  created INTEGER NOT NULL, last INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  uid TEXT PRIMARY KEY REFERENCES users(id),
  data TEXT NOT NULL,            -- the player's saved game (JSON of dt_* keys)
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll, updated);
`);

const q = {
  userBySub: sql.prepare("SELECT * FROM users WHERE sub = ?"),
  userById: sql.prepare("SELECT * FROM users WHERE id = ?"),
  insUser: sql.prepare("INSERT INTO users (id, sub, email, name, picture, created, last) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  touchUser: sql.prepare("UPDATE users SET email = ?, name = ?, picture = ?, last = ? WHERE id = ?"),
  getProfile: sql.prepare("SELECT data, updated FROM profiles WHERE uid = ?"),
  putProfile: sql.prepare("INSERT INTO profiles (uid, data, updated) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET data = excluded.data, updated = excluded.updated"),
  getDoc: sql.prepare("SELECT data FROM docs WHERE coll = ? AND id = ?"),
  putDoc: sql.prepare("INSERT INTO docs (coll, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated = excluded.updated"),
  collDocs: sql.prepare("SELECT id, data FROM docs WHERE coll = ?"),
  pruneDuels: sql.prepare("DELETE FROM docs WHERE coll = 'duels' AND updated < ?"),
};

export function upsertUser({ id, sub, email, name, picture }) {
  const now = Date.now();
  const u = q.userBySub.get(sub);
  if (u) { q.touchUser.run(email || null, name || null, picture || null, now, u.id); return { ...u, email, name, picture }; }
  q.insUser.run(id, sub, email || null, name || null, picture || null, now, now);
  return q.userById.get(id);
}
export const userById = (id) => q.userById.get(id) || null;

export function getProfile(uid) {
  const r = q.getProfile.get(uid);
  return r ? { data: JSON.parse(r.data), updated: r.updated } : null;
}
export function putProfile(uid, data) {
  const updated = Date.now();
  q.putProfile.run(uid, JSON.stringify(data), updated);
  return updated;
}

export function getDoc(coll, id) {
  const r = q.getDoc.get(coll, id);
  return r ? JSON.parse(r.data) : null;
}
export function putDoc(coll, id, data) { q.putDoc.run(coll, id, JSON.stringify(data), Date.now()); }

/* Small in-memory cache per collection so live queries don't hit disk on every write. */
const cache = new Map();
function collection(coll) {
  if (!cache.has(coll)) {
    const m = new Map();
    for (const r of q.collDocs.all(coll)) m.set(r.id, JSON.parse(r.data));
    cache.set(coll, m);
  }
  return cache.get(coll);
}
export function writeDoc(coll, id, data) { putDoc(coll, id, data); collection(coll).set(id, data); }
export function readDoc(coll, id) { const m = collection(coll); return m.has(id) ? m.get(id) : null; }

/* Run a query: { where: [field, "==", value], orderBy: [field, "asc"|"desc"], limit } */
export function query(coll, { where, orderBy, limit } = {}) {
  let rows = [...collection(coll)].map(([id, data]) => ({ id, data }));
  if (where) rows = rows.filter((r) => r.data[where[0]] === where[2]);
  if (orderBy) {
    const [f, dir] = orderBy, s = dir === "desc" ? -1 : 1;
    rows.sort((a, b) => ((a.data[f] ?? 0) > (b.data[f] ?? 0) ? s : (a.data[f] ?? 0) < (b.data[f] ?? 0) ? -s : 0));
  }
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

/* Duel invites older than 30 days are cleared once a day. */
export function pruneOld() {
  q.pruneDuels.run(Date.now() - 30 * 864e5);
  cache.delete("duels");
}
