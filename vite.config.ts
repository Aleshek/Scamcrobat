import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Strict Content-Security-Policy for the production build only (the Vite dev server
// needs inline scripts and a websocket for HMR).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "scamcrobat-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  // Relative paths, so the build works from the app:// protocol and from any subfolder of a website.
  base: "./",
  plugins: [react(), cspPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // MuPDF loads its own .wasm through import.meta.url – it must not be pre-bundled.
    exclude: ["mupdf"],
  },
});
