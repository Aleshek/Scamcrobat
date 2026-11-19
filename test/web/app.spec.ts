// The web version in a real browser: opening, searching, forms, comments, organizing pages
// and saving – checked in the saved file itself.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import * as mupdf from "mupdf";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** Errors in the console or uncaught in the page (a blocked script, a failed request…). */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function openPdf(page: Page, name: string) {
  await page.goto("./?lang=en");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await (await chooser).setFiles(fixture(name));
  await expect(page).toHaveTitle(new RegExp(name.replace(".", "\\.")));
  await expect(page.locator(".page-canvas:not(.pending)").first()).toBeVisible();
}

/** Saves with Ctrl+S as a browser download (without the file picker) and opens the file with MuPDF. */
async function save(page: Page): Promise<mupdf.PDFDocument> {
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const bytes = await readFile(await (await download).path());
  return mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
}

test.beforeEach(async ({ page }) => {
  // Saving falls back to a download, which the test can read.
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined }));
});

test("opens a PDF and finds text without errors", async ({ page }) => {
  const errors = watchErrors(page);
  await openPdf(page, "demo-en.pdf");
  await expect(page.locator(".tb-muted")).toHaveText("/ 6");
  await expect(page.locator(".thumb")).toHaveCount(6);

  const search = page.getByRole("textbox", { name: "Search document" });
  await search.fill("ravens");
  await search.press("Enter");
  await expect(page.locator(".search-status")).toHaveText(/^1 \/ \d+$/);
  await expect(page.locator(".hl-search.active").first()).toBeVisible();
  // nothing blocked by the Content-Security-Policy, no failed requests
  expect(errors).toEqual([]);
});

test("fills in a form and saves it", async ({ page }) => {
  await openPdf(page, "form.pdf");
  const name = page.getByLabel("name", { exact: true });
  await name.fill("Jana Nováková");
  await name.press("Tab");
  await page.getByLabel("binoculars", { exact: true }).click();
  await expect(page.locator(".tab.dirty")).toBeVisible();

  const doc = await save(page);
  const values = Object.fromEntries(
    doc
      .loadPage(0)
      .getWidgets()
      .map((w) => [w.getName(), w.getValue()]),
  );
  expect(values.name).toBe("Jana Nováková");
  expect(values.binoculars).toBe("Yes");
});

test("highlights text and saves the highlight", async ({ page }) => {
  await openPdf(page, "demo-en.pdf");
  // toolbar buttons by their tooltips: their labels hide when the window is narrow
  await page.getByTitle("Highlight, comment, draw and add text").click();
  await page.getByRole("button", { name: "Highlight text" }).click();

  // where the word is: let the search show it (after the annotation bar moved the pages)
  const search = page.getByRole("textbox", { name: "Search document" });
  await search.fill("Corvids");
  await search.press("Enter");
  const hit = page.locator(".hl-search.active").first();
  await expect(hit).toBeVisible();
  const box = (await hit.boundingBox())!;
  await search.press("Escape");
  await expect(hit).toBeHidden();

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
  await page.mouse.move(box.x + box.width - 2, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".tab.dirty")).toBeVisible();

  const doc = await save(page);
  const highlights = doc
    .loadPage(0)
    .getAnnotations()
    .filter((a) => a.getType() === "Highlight");
  expect(highlights).toHaveLength(1);
});

test("deletes a page in the organizer", async ({ page }) => {
  await openPdf(page, "demo-en.pdf");
  await page.getByTitle("Rotate, delete, reorder, insert or split pages").click();
  await expect(page.locator(".org-cell")).toHaveCount(6);
  await page.locator(".org-cell").nth(1).click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".org-cell")).toHaveCount(5);
  await page.getByTitle("Apply the changes and return to the document").click();
  await expect(page.locator(".tb-muted")).toHaveText("/ 5");

  const doc = await save(page);
  expect(doc.countPages()).toBe(5);
});
