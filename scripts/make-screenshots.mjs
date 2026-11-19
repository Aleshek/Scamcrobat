// Makes the screenshots in the README (docs/*.png in English, docs/cs/*.png in Czech, each in
// a light and a dark version). The desktop app is started against the Vite dev server with a
// clean profile; a script in the window opens the demo documents and sets up the scene, then
// the window is captured.
//
// Usage: npm run screenshots [-- annotate cs]   (only the given scenes / languages)
// Windows; Electron must be installed (node node_modules/electron/install.js).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import * as mupdf from "mupdf";
import { createServer } from "vite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const THEMES = ["light", "dark"];
/** Wide enough for the labels of the main buttons in both languages. */
const WINDOW_SIZE = "1500x900";

/** What each language's scenes show. */
const LANGS = {
  en: {
    out: "docs",
    demo: "/test/fixtures/demo-en.pdf",
    guide: "corvids-field-guide.pdf",
    invoice: "invoice-2026-03.pdf",
    notes: "meeting-notes.pdf",
    appendix: "appendix.pdf",
    query: "crows",
    highlight: "crows, ravens, rooks, jackdaws, magpies and jays",
    underline: "largest songbird in the world",
    strike: "noisy",
    circle: "Antarctica",
    note: "Add a map of where they live?",
    textBox: "Add a photo of a raven\nin flight here",
    approved: "Approved for print",
    signature: "A. Corvin",
  },
  cs: {
    out: "docs/cs",
    demo: "/test/fixtures/demo-cs.pdf",
    guide: "krkavcovití-průvodce.pdf",
    invoice: "faktura-2026-03.pdf",
    notes: "zápis-z-porady.pdf",
    appendix: "příloha.pdf",
    query: "vrány",
    highlight: "vrány, krkavci, havrani, kavky, straky a sojky",
    underline: "největší pěvec na světě",
    strike: "hlučných",
    circle: "Antarktidy",
    note: "Přidat mapu, kde žijí?",
    textBox: "Sem přidat fotku krkavce\nv letu",
    approved: "Schváleno k tisku",
    signature: "A. Krkavcová",
  },
};

/**
 * The scenes, in the order of the README. `height` crops the screenshot (the organizer
 * shows two rows of pages).
 */
const SHOTS = [{ name: "viewer" }, { name: "annotate" }, { name: "organizer", height: 510 }];

/** Runs in the app window (it cannot use anything from this file). */
async function scene(shot, o) {
  // Nothing may look hovered where the real mouse pointer happens to be (the scene only
  // uses synthetic events, which do not need it).
  const noHover = document.createElement("style");
  noHover.textContent = "* { pointer-events: none !important; }";
  document.head.append(noHover);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, what, ms = 10000) => {
    for (const end = Date.now() + ms; !test(); await wait(50)) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    }
  };
  const load = async (url) => (await fetch(url)).arrayBuffer();
  const tabs = () => document.querySelectorAll(".tab").length;
  // Dropping files is how they get in without a dialog; the first drop right after start
  // can be lost, so it is repeated until the tabs appear. In the page organizer the pages
  // are inserted instead (`newTabs` false).
  const drop = async (files, newTabs = true) => {
    for (let attempt = 0; ; attempt++) {
      const before = tabs();
      const dt = new DataTransfer();
      for (const [data, name] of files) dt.items.add(new File([data], name, { type: "application/pdf" }));
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      if (!newTabs) return wait(1500);
      try {
        return await until(() => tabs() >= before + files.length, "the dropped files", 3000);
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
  };
  const view = () => document.querySelector(".doc-view:not(.inactive)");
  const button = (title) => {
    const b = [...view().querySelectorAll(".tb-btn")].find((x) => x.title === title);
    if (!b) throw new Error(`No button "${title}"`);
    return b;
  };
  const type = async (input, text) => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(50);
  };
  const enter = (input) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  /** Goes to a page (only the pages near the view exist), then puts its top `above` px below the top. */
  const showPage = async (index, above = 16) => {
    const input = view().querySelector(".page-input");
    await type(input, String(index + 1));
    enter(input);
    await until(() => view()?.querySelector(`.page[data-page="${index}"]`), `page ${index + 1}`);
    await wait(300);
    const viewer = view().querySelector(".viewer");
    viewer.scrollTop = view().querySelector(`.page[data-page="${index}"]`).offsetTop - above;
  };
  const { msg } = await import("/src/i18n/index.ts");
  const t = msg();
  const demo = await load(o.demo);
  const sample = await load("/test/fixtures/sample.pdf");

  if (shot === "viewer") {
    await drop([[sample, o.invoice], [demo, o.guide], [sample, o.notes]]);
    await wait(1500);
    document.querySelectorAll(".tab")[1].click();
    await wait(800);
    const input = view().querySelector(".search-input");
    await type(input, o.query);
    // Enter searches, then goes to the next hit – until the first hit on page 3.
    const pageNumber = () => view().querySelector(".page-input")?.value;
    for (let i = 0; i < 8 && pageNumber() !== "3"; i++) {
      enter(input);
      await wait(700);
    }
    input.blur();
    await showPage(2, 60);
    await wait(2000);
    return view().querySelector(".search-status")?.textContent;
  }

  if (shot === "annotate") {
    // The comments and the signature are made by the app's own engine in a copy of the demo,
    // which is then opened like any other file.
    const engine = window.__engine;
    const { PALETTE, textBoxRect } = await import("/src/annotate/tools.ts");
    const { signatureBytes, signatureFromCanvas } = await import("/src/annotate/signatures.ts");
    const color = Object.fromEntries(PALETTE.map((p) => [p.name, p.color]));
    const { docId } = await engine.open(demo.slice(0), "scene.pdf");
    const page = 1;
    const add = (annot) => engine.editAnnot(docId, page, { op: "create", annot });
    const quads = async (needle) => {
      const hit = (await engine.search(docId, needle)).find((h) => h.page === page);
      if (!hit) throw new Error(`"${needle}" is not on page ${page + 1}`);
      return hit.quads;
    };
    await add({ type: "Highlight", quads: await quads(o.highlight), color: color.yellow });
    await add({ type: "Underline", quads: await quads(o.underline), color: color.blue });
    await add({ type: "StrikeOut", quads: await quads(o.strike), color: color.red });

    // A hand-drawn ring around a word.
    const q = (await quads(o.circle))[0];
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const ring = [];
    for (let a = -0.5; a <= Math.PI * 2 + 0.35; a += 0.12) {
      const wobble = 1 + 0.05 * Math.sin(a * 3);
      const x = (x0 + x1) / 2 + Math.cos(a) * ((x1 - x0) / 2 + 5) * wobble;
      const y = (y0 + y1) / 2 + Math.sin(a) * ((y1 - y0) / 2 + 7) * wobble + a * 0.5;
      ring.push([x, y]);
    }
    await add({ type: "Ink", strokes: [ring], color: color.red, width: 2.5 });

    await add({ type: "Text", rect: [540, 186, 560, 206], text: o.note, color: color.yellow });
    await add({ type: "FreeText", rect: textBoxRect([66, 300], o.textBox, 14), text: o.textBox, color: color.blue, size: 14 });
    await add({ type: "FreeText", rect: textBoxRect([330, 300], o.approved, 12), text: o.approved, color: color.green, size: 12 });

    // A signature "drawn" on the signature pad.
    const pad = document.createElement("canvas");
    pad.width = 1000;
    pad.height = 300;
    const ctx = pad.getContext("2d");
    ctx.fillStyle = ctx.strokeStyle = "#1d3fbf";
    ctx.font = 'italic 110px "Segoe Script", "Brush Script MT", cursive';
    ctx.fillText(o.signature, 30, 170);
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(60, 230);
    ctx.bezierCurveTo(300, 200, 600, 250, 900, 190);
    ctx.stroke();
    const sig = signatureFromCanvas(pad);
    const w = 150;
    const h = (w * sig.height) / sig.width;
    await add({ type: "Stamp", rect: [330, 322, 330 + w, 322 + h], image: signatureBytes(sig) });

    const data = await engine.getBytes(docId);
    await engine.close(docId);
    await drop([[data, o.guide]]);
    await wait(1200);
    button(t.toolbar.annotateTitle).click();
    await wait(800);
    await showPage(page);
    await wait(2000);
    return [...view().querySelectorAll(".tb-btn")].length;
  }

  if (shot === "organizer") {
    await drop([[demo, o.guide]]);
    await wait(1500);
    button(t.toolbar.organizeTitle).click();
    await wait(800);
    await drop([[sample, o.appendix]], false);
    const cells = () => document.querySelectorAll(".org-cell");
    cells()[9].click();
    await wait(100);
    document.querySelectorAll(".org-bar .tb-btn")[2].click(); // rotate right
    await wait(100);
    cells()[1].click();
    await wait(50);
    cells()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await wait(50);
    cells()[4].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    document.querySelector(".org-scroll").dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }));
    await wait(2000);
    return document.querySelector(".org-status")?.innerText.split("\n")[0];
  }
  throw new Error(`Unknown scene ${shot}`);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

/** Keeps only the top `height` pixels of a PNG. */
async function cropPng(file, height) {
  const image = new mupdf.Image(await fs.readFile(file));
  const full = image.toPixmap();
  const [x0, y0, x1] = full.getBounds();
  const cropped = new mupdf.Pixmap(full.getColorSpace(), [x0, y0, x1, y0 + height], full.getAlpha());
  cropped.getPixels().set(full.getPixels().subarray(0, full.getStride() * height));
  await fs.writeFile(file, cropped.asPNG());
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scamcrobat-shots-"));
const server = await createServer({ root: ROOT, logLevel: "error", clearScreen: false });
await server.listen();
const url = server.resolvedUrls?.local[0];
const only = process.argv.slice(2);
const pick = (names) => names.filter((n) => !names.some((x) => only.includes(x)) || only.includes(n));
let failed = false;
try {
  for (const lang of pick(Object.keys(LANGS))) {
    const o = LANGS[lang];
    for (const shot of SHOTS.filter((s) => pick(SHOTS.map((x) => x.name)).includes(s.name))) {
      const script = path.join(tmp, `${shot.name}-${lang}.js`);
      await fs.writeFile(script, `(${scene})(${JSON.stringify(shot.name)}, ${JSON.stringify(o)})`);
      for (const theme of THEMES) {
        const file = path.join(ROOT, o.out, `${shot.name}-${theme}.png`);
        await fs.rm(file, { force: true });
        const { output } = await run(electronPath, ["."], {
          SCAMCROBAT_DEV_URL: url,
          SCAMCROBAT_USER_DATA: path.join(tmp, `profile-${lang}-${shot.name}-${theme}`),
          SCAMCROBAT_LANG: lang,
          SCAMCROBAT_SMOKE_SHOT: file,
          SCAMCROBAT_SMOKE_SCRIPT: script,
          SCAMCROBAT_SMOKE_THEME: theme,
          SCAMCROBAT_SMOKE_SIZE: WINDOW_SIZE,
          SCAMCROBAT_SMOKE_DELAY: "1500",
        });
        const result = /\[smoke\] script(.*)/.exec(output)?.[1] ?? "";
        const ok = result.startsWith("=") && (await fs.stat(file).catch(() => null));
        console.log(`${ok ? "ok  " : "FAIL"} ${path.relative(ROOT, file)} ${result}`);
        if (!ok) {
          failed = true;
          console.log(output);
          continue;
        }
        if (shot.height) await cropPng(file, shot.height);
      }
    }
  }
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
