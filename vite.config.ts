import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Přísná Content-Security-Policy jen pro produkční build (dev server Vite
// potřebuje inline skripty a websocket pro HMR).
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
  // Relativní cesty, aby build fungoval z app:// protokolu i z libovolné podsložky webu.
  base: "./",
  plugins: [react(), cspPlugin()],
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // MuPDF načítá vlastní .wasm přes import.meta.url – nesmí se předbalit.
    exclude: ["mupdf"],
  },
});
