// Organizing pages, merging, cropping, watermarks and page numbers.
import { describe, expect, it } from "vitest";
import { call, open, pageText, reopen } from "./harness";

describe("organizing and merging", () => {
  it("reorders and rotates pages, keeping the original's bookmarks and forms", async () => {
    const form = await open("form.pdf");
    const built = await call("compose", {
      pages: [
        { docId: form.docId, page: 1, rotate: 0 },
        { docId: form.docId, page: 0, rotate: 90 },
      ],
      base: form.docId,
    });
    expect(built.pageCount).toBe(2);
    // the first page is now the rules page; the form page lies on its side
    expect((await call("search", { docId: built.docId, needle: "Club rules" }))[0].page).toBe(0);
    expect(built.pages[1].width).toBeCloseTo(form.pages[0].height, 0);
    // the form fields came along
    const { widgets } = await call("pageExtras", { docId: built.docId, page: 1 });
    expect(widgets.map((w) => w.name)).toContain("binoculars");
    await call("close", { docId: built.docId });
    await call("close", { docId: form.docId });
  });

  it("merges documents with a bookmark for each of them", async () => {
    const en = await open("demo-en.pdf");
    const cs = await open("demo-cs.pdf");
    const pages = [en, cs].flatMap((d) => d.pages.map((_, page) => ({ docId: d.docId, page, rotate: 0 })));
    const merged = await call("compose", {
      pages,
      files: [
        { docId: en.docId, title: "demo-en.pdf" },
        { docId: cs.docId, title: "demo-cs.pdf" },
      ],
    });
    expect(merged.pageCount).toBe(12);
    expect(merged.outline.map((n) => [n.title, n.page])).toEqual([
      ["demo-en.pdf", 0],
      ["demo-cs.pdf", 6],
    ]);
    expect(merged.outline[1].children.length).toBe(6);
    for (const d of [merged, en, cs]) await call("close", { docId: d.docId });
  });

  it("extracts pages into a new file", async () => {
    const { docId } = await open("sample.pdf");
    const bytes = await call("buildPdf", { pages: [{ docId, page: 2, rotate: 0 }] });
    const doc = reopen(bytes);
    expect(doc.countPages()).toBe(1);
    expect(pageText(doc, 0)).toMatch(/Kapitola 3/);
    await call("close", { docId });
  });
});

describe("page tools", () => {
  it("crops pages and undoes it", async () => {
    const { docId, pages } = await open("demo-en.pdf");
    const state = await call("crop", { docId, pages: [0], margins: { left: 50, top: 40, right: 50, bottom: 40 } });
    expect(state.pages![0].width).toBeCloseTo(pages[0].width - 100, 1);
    expect(state.pages![0].height).toBeCloseTo(pages[0].height - 80, 1);
    expect(state.pages![1].width).toBeCloseTo(pages[1].width, 1);
    const undone = await call("undo", { docId });
    expect(undone.pages![0].width).toBeCloseTo(pages[0].width, 1);
    await call("close", { docId });
  });

  it("refuses to crop a page to nothing", async () => {
    const { docId, pages } = await open("demo-en.pdf");
    const half = pages[0].width / 2;
    await expect(call("crop", { docId, pages: [0], margins: { left: half, top: 0, right: half, bottom: 0 } })).rejects.toMatchObject({
      code: "CROP_TOO_SMALL",
    });
    await call("close", { docId });
  });

  it("writes a watermark and page numbers into the pages", async () => {
    const { docId, pageCount } = await open("demo-cs.pdf");
    const base = { size: 40, color: [0.8, 0, 0] as [number, number, number], opacity: 0.3, under: false };
    await call("stamp", {
      docId,
      stamp: { ...base, kind: "watermark", texts: [{ page: 0, text: "KONCEPT" }], rotation: 45, position: "center" },
    });
    await call("stamp", {
      docId,
      stamp: {
        ...base,
        size: 10,
        kind: "pageNumbers",
        texts: Array.from({ length: pageCount }, (_, page) => ({ page, text: `Strana ${page + 1} z ${pageCount}` })),
        rotation: 0,
        position: "bottom-center",
      },
    });
    const saved = reopen(await call("getBytes", { docId }));
    expect(pageText(saved, 0)).toMatch(/KONCEPT/);
    expect(pageText(saved, 5)).toMatch(/Strana 6 z 6/);
    await call("close", { docId });
  });
});
