/* App shell: connect to the server, restore the signed-in player's profile, then start the game. */
import "./game/style.css";
import "./app.css";
import gameUrl from "./game/game.js?url";
import { createAccount } from "./account.js";
import { createPlatform } from "./platform.js";

const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
const account = await createAccount(cfg);
window.DTAccount = account;
window.claude = createPlatform(account);

const s = document.createElement("script");
s.src = gameUrl;
s.onload = () => document.documentElement.classList.add("ready");
document.body.appendChild(s);

/* The page has usually finished loading by now (the awaits above), so register straight away in that case. */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const registerSW = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (document.readyState === "complete") registerSW();
  else addEventListener("load", registerSW);
}
