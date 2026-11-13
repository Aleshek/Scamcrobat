// Development mode of the desktop app: starts the Vite dev server and Electron against it.
// Usage: npm run dev:app [-- path\to\file.pdf]
import { spawn } from "node:child_process";
import { createServer } from "vite";
import electronPath from "electron";

const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local[0];
console.log(`Vite is running at ${url}`);

const child = spawn(electronPath, [".", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, SCAMCROBAT_DEV_URL: url },
});

child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
