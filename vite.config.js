import { defineConfig } from "vite";
import { transform } from "esbuild";

/* The game engine is a classic script (it relies on global functions and later-wins overrides),
   so Vite ships it as a file instead of a module. This plugin still minifies it for production. */
function minifyGameScript() {
  return {
    name: "minify-game-script",
    apply: "build",
    async generateBundle(_, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type === "asset" && /assets\/game-[\w-]+\.js$/.test(f.fileName)) {
          const out = await transform(String(f.source), { loader: "js", minify: true, legalComments: "none", target: "es2020" });
          f.source = out.code;
        }
      }
    },
  };
}

const API = process.env.API_URL || "http://localhost:8787";
export default defineConfig({
  plugins: [minifyGameScript()],
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0, sourcemap: false },
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": API, "/healthz": API, "/socket.io": { target: API, ws: true } },
  },
});
