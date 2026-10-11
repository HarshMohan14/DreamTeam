/*
 * Google account + profile sync.
 * The game keeps its state in localStorage under "dt_*" keys. When signed in, every change is
 * saved to the player's account (debounced), and the account copy is loaded on any device.
 */
const META = "dtw_meta";
const isGameKey = (k) => typeof k === "string" && k.startsWith("dt_");
const readMeta = () => { try { return JSON.parse(localStorage.getItem(META)) || {}; } catch { return {}; } };
const writeMeta = (m) => { try { localStorage.setItem(META, JSON.stringify(m)); } catch {} };
const gameKeys = () => Object.keys(localStorage).filter(isGameKey);
const snapshot = () => Object.fromEntries(gameKeys().map((k) => [k, localStorage.getItem(k)]));
const num = (v) => { try { return +JSON.parse(v) || 0; } catch { return 0; } };
const localXp = () => num(localStorage.getItem("dt_xp"));
const hasLocalProgress = () => localXp() > 0 || !!localStorage.getItem("dt_team");

const rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
function replaceLocal(data) {
  for (const k of gameKeys()) rawRemove.call(localStorage, k);
  for (const [k, v] of Object.entries(data || {})) if (isGameKey(k)) rawSet.call(localStorage, k, v);
}

let gsiLoading = null;
function loadGSI() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiLoading) gsiLoading = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = res; s.onerror = () => { gsiLoading = null; rej(new Error("Google sign-in couldn't load")); };
    document.head.appendChild(s);
  });
  return gsiLoading;
}

export async function createAccount(cfg) {
  const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
  const listeners = new Set(), connListeners = new Set();
  const A = {
    user: me?.user || null,
    status: "idle",           // idle | saving | saved | offline | error
    savedAt: null,
    connected: false,
    onStatus(cb) { listeners.add(cb); },
    onConnection(cb) { connListeners.add(cb); },
    setConnected(v) { if (A.connected !== v) { A.connected = v; connListeners.forEach((cb) => cb(v)); } },
    syncText() {
      if (A.status === "saving") return "Saving…";
      if (A.status === "offline") return "Offline · saves when you're back";
      if (A.status === "error") return "Couldn't save · retrying";
      return "Saved to your Google account";
    },
  };
  const setStatus = (s) => { A.status = s; listeners.forEach((cb) => cb(s)); };

  /* ---- merge on load ---- */
  function adopt(user, profile) {
    const meta = readMeta();
    if (!profile) {                       // brand-new account: this device's progress becomes the account
      writeMeta({ uid: user.id, synced: 0, dirty: true });
      return;
    }
    const serverXp = num(profile.data?.dt_xp);
    let takeServer;
    if (meta.uid === user.id) takeServer = profile.updated > (meta.synced || 0) && !(meta.dirty && localXp() > serverXp);
    else if (!meta.uid && hasLocalProgress()) takeServer = serverXp >= localXp();   // guest progress: keep whichever went further
    else takeServer = true;               // a different account used this device
    if (takeServer) { replaceLocal(profile.data); writeMeta({ uid: user.id, synced: profile.updated, dirty: false }); }
    else writeMeta({ uid: user.id, synced: profile.updated, dirty: true });
  }
  if (A.user) adopt(A.user, me.profile);
  else {
    const meta = readMeta();
    if (me && meta.uid) { replaceLocal({}); writeMeta({}); }   // signed out elsewhere: don't leave an account's data on the device
  }

  /* ---- save changes ---- */
  let timer = null, inflight = null, retry = 2000;
  async function save(keepalive = false) {
    clearTimeout(timer); timer = null;
    if (!A.user) return;
    const meta = readMeta();
    if (!meta.dirty) return;
    if (!navigator.onLine) { setStatus("offline"); return; }
    const body = JSON.stringify({ data: snapshot() });
    meta.dirty = false; writeMeta(meta);
    setStatus("saving");
    inflight = fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body, credentials: "same-origin", keepalive: keepalive && body.length < 60000 })
      .then(async (r) => {
        if (r.status === 401) { A.user = null; setStatus("error"); return; }
        if (!r.ok) throw new Error(String(r.status));
        const { updated } = await r.json();
        const m = readMeta(); m.synced = updated; writeMeta(m);
        A.savedAt = Date.now(); retry = 2000; setStatus("saved");
      })
      .catch(() => { const m = readMeta(); m.dirty = true; writeMeta(m); setStatus(navigator.onLine ? "error" : "offline"); timer = setTimeout(save, retry); retry = Math.min(retry * 2, 60000); })
      .finally(() => { inflight = null; });
    return inflight;
  }
  function markDirty() {
    if (!A.user) return;
    const m = readMeta(); if (!m.dirty) { m.dirty = true; writeMeta(m); }
    clearTimeout(timer); timer = setTimeout(save, 1500);
  }
  Storage.prototype.setItem = function (k, v) { rawSet.call(this, k, v); if (this === localStorage && isGameKey(k)) markDirty(); };
  Storage.prototype.removeItem = function (k) { rawRemove.call(this, k); if (this === localStorage && isGameKey(k)) markDirty(); };
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(true); });
  addEventListener("pagehide", () => save(true));
  addEventListener("online", () => save());
  if (A.user && readMeta().dirty) setTimeout(save, 800);

  /* ---- sign in / out ---- */
  async function finishSignIn(resp) {
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok || !out.user) throw new Error(out.error || "Sign-in failed");
    A.user = out.user;
    adopt(out.user, out.profile);
    await save();
    location.reload();
  }
  A.signInWithGoogle = async (credential) =>
    finishSignIn(await fetch("/api/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential }), credentials: "same-origin" }));
  A.devSignIn = async (name) =>
    finishSignIn(await fetch("/api/auth/dev", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }), credentials: "same-origin" }));

  A.signOut = async () => {
    try { await save(); if (inflight) await inflight; } catch {}
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    try { window.google?.accounts?.id?.disableAutoSelect(); } catch {}
    replaceLocal({}); writeMeta({});
    location.reload();
  };

  let gsiReady = null;
  function initGSI() {
    if (!cfg.googleClientId) return Promise.reject(new Error("no client id"));
    if (!gsiReady) gsiReady = loadGSI().then(() => {
      window.google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: (r) => A.signInWithGoogle(r.credential).catch((e) => alert(e.message)),
        auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_prompt: true, context: "signin",
      });
    });
    return gsiReady;
  }

  A.renderButton = (el) => {
    if (!el || el.dataset.ready) return;
    el.dataset.ready = "1";
    if (cfg.googleClientId) {
      initGSI().then(() => {
        const w = Math.min(360, Math.max(220, Math.round(el.getBoundingClientRect().width || 300)));
        window.google.accounts.id.renderButton(el, { theme: "filled_black", size: "large", shape: "pill", text: "continue_with", logo_alignment: "left", width: w });
      }).catch(() => { el.innerHTML = `<p class="ac-err">Google sign-in couldn't load. Check your connection and try again.</p>`; });
    } else if (cfg.devLogin) {
      el.innerHTML = `<button class="ac-dev" type="button">Sign in (local test account)</button>`;
      el.firstChild.onclick = () => { const n = prompt("Test player name", "Tester"); if (n) A.devSignIn(n).catch((e) => alert(e.message)); };
    } else {
      el.innerHTML = `<p class="ac-err">Sign-in isn't switched on for this server yet.</p>`;
    }
  };

  let oneTapShown = false;
  A.oneTap = () => {
    if (oneTapShown || A.user || !cfg.googleClientId) return;
    try { if (sessionStorage.getItem("dtw_onetap")) return; sessionStorage.setItem("dtw_onetap", "1"); } catch {}
    oneTapShown = true;
    setTimeout(() => initGSI().then(() => window.google.accounts.id.prompt()).catch(() => {}), 2500);
  };

  return A;
}
