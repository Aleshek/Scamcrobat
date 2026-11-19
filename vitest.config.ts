// Automated tests (`npm test`): the PDF engine runs in Node with the same MuPDF as the app.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // MuPDF (WebAssembly) takes a moment to load, and some tests write whole documents.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
