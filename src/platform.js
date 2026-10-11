/*
 * Connects the game to the Dream Team server.
 * The game talks to four services: user, db (leaderboard + duel inbox), room (who's online, live invites)
 * and downloads (saving the share card). This module provides them over one Socket.IO connection.
 */
import { io } from "socket.io-client";

function guestId() {
  try {
    let g = localStorage.getItem("dtw_guest");
    if (!g) { g = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); localStorage.setItem("dtw_guest", g); }
    return g;
  } catch { return Math.random().toString(36).slice(2, 12); }
}

export function createPlatform(account) {
  const sock = io({ auth: { guest: guestId() }, transports: ["websocket", "polling"], reconnectionDelayMax: 8000 });
  let hello = null, rawPeers = [], myPresence = null;
  const peerCbs = new Set(), subs = new Map();
  let sidN = 0;

  const peersView = () => !hello ? [] : rawPeers.map((p) => ({ ...p, isMe: p.by === hello.by, sameTab: p.peer === hello.peer }));
  const emitPeers = () => { const ch = { peers: peersView() }; peerCbs.forEach((cb) => { try { cb(ch); } catch (e) { console.error(e); } }); };

  sock.on("hello", (h) => {
    hello = h;
    if (myPresence) sock.emit("presence", myPresence);
    for (const [sid, s] of subs) sock.emit("db:sub", { sid, ...s.q });
    account.setConnected(true);
    emitPeers();
  });
  sock.on("disconnect", () => { account.setConnected(false); });
  sock.on("peers", (list) => { rawPeers = Array.isArray(list) ? list : []; emitPeers(); });
  sock.on("db:snap", ({ sid, docs }) => {
    const s = subs.get(sid);
    if (!s) return;
    s.cb({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });
  });

  /* ---- room ---- */
  const room = {
    presence(p) { myPresence = p; if (sock.connected) sock.emit("presence", p); return Promise.resolve(); },
    peers() { return peersView(); },
    onPeers(cb) { peerCbs.add(cb); if (hello) cb({ peers: peersView() }); return () => peerCbs.delete(cb); },
  };

  /* ---- db ---- */
  function makeQuery(coll, q = {}) {
    return {
      where(f, op, v) { return makeQuery(coll, { ...q, where: [f, op, v] }); },
      orderBy(f, dir = "asc") { return makeQuery(coll, { ...q, orderBy: [f, dir] }); },
      limit(n) { return makeQuery(coll, { ...q, limit: n }); },
      onSnapshot(cb, err) {
        const sid = "s" + ++sidN, full = { coll, ...q };
        subs.set(sid, { q: full, cb });
        if (sock.connected) sock.emit("db:sub", { sid, ...full }, (r) => { if (r && r.error) { subs.delete(sid); err && err(new Error(r.error)); } });
        return () => { subs.delete(sid); sock.emit("db:unsub", sid); };
      },
    };
  }
  function write(op, path, data) {
    return new Promise((resolve, reject) => {
      if (!account.user) return reject(Object.assign(new Error("Sign in to save"), { code: "signin" }));
      sock.timeout(8000).emit("db:write", { op, path, data }, (e, r) => {
        if (e) return reject(new Error("Server didn't answer"));
        if (r && r.error) return reject(new Error(r.error));
        resolve();
      });
    });
  }
  const db = {
    collection: (c) => makeQuery(c),
    doc: (path) => ({ set: (d) => write("set", path, d), update: (d) => write("update", path, d) }),
  };

  /* ---- user ---- */
  const user = {
    id: async () => (account.user ? account.user.id : null),
    can: async (what) => (what === "data.write" ? !!account.user : false),
    profile: async () => account.user,
  };

  /* ---- downloads: share sheet on phones (save to Photos), file download elsewhere ---- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const file = new File([blob], filename, { type: blob.type || "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        try { await navigator.share({ files: [file] }); return; }
        catch (e) { if (e && e.name === "AbortError") throw Object.assign(new Error("declined"), { code: "declined" }); }
      }
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },
  };

  const services = { room, db, user, downloads };
  return { use: async (name) => services[name] || null, socket: sock };
}
