/* npm run dev: starts the API/duel server and the Vite dev server together. */
import { spawn } from "node:child_process";
const run = (cmd, args, name) => {
  const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, DEV_LOGIN: process.env.DEV_LOGIN ?? "1" } });
  p.on("exit", (c) => { console.log(`${name} exited (${c})`); process.exit(c ?? 0); });
  return p;
};
const kids = [run("node", ["--disable-warning=ExperimentalWarning", "--watch", "server/index.js"], "server"), run("npx", ["vite"], "vite")];
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { kids.forEach((k) => k.kill()); process.exit(0); });
