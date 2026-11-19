// Opening documents, bookmarks, search and text selection.
import { describe, expect, it } from "vitest";
import { call, EngineFailure, open } from "./harness";

describe("opening", () => {
  it("reads pages, labels and bookmarks", async () => {
    const info = await open("demo-en.pdf");
    expect(info.isPdf).toBe(true);
    expect(info.pageCount).toBe(6);
    expect(info.pages).toHaveLength(6);
    expect(info.pages[0].width).toBeGreaterThan(500);
    expect(info.outline.length).toBe(6);
    expect(info.outline.every((node) => node.page !== null)).toBe(true);
    await call("close", { docId: info.docId });
  });

  it("refuses something that is not a document", async () => {
    const junk = new TextEncoder().encode("this is not a PDF");
    await expect(open(junk)).rejects.toBeInstanceOf(EngineFailure);
  });
});

describe("search", () => {
  it("ignores case and diacritics, like browsers", async () => {
    const { docId } = await open("sample.pdf");
    const hits = await call("search", { docId, needle: "KOPRETINA" });
    // "kopretina" is on every one of the six pages
    expect(new Set(hits.map((h) => h.page))).toEqual(new Set([0, 1, 2, 3, 4, 5]));

    const czech = await call("search", { docId, needle: "zlutoucky kun" });
    expect(czech.length).toBeGreaterThan(6);
    expect(czech[0].quads.length).toBeGreaterThan(0);
    await call("close", { docId });
  });

  it("finds words on every page of a longer document", async () => {
    const { docId } = await open("demo-en.pdf");
    const crows = await call("search", { docId, needle: "crows" });
    expect(crows.length).toBeGreaterThan(3);
    expect(await call("search", { docId, needle: "no such words here" })).toEqual([]);
    await call("close", { docId });
  });
});

describe("text selection", () => {
  /** Selects by words from a point on one search hit to a point on another, like a double click. */
  async function selectWords(file: string, fromWord: string, toWord = fromWord, along = 0.5) {
    const { docId } = await open(file);
    try {
      const [a] = await call("search", { docId, needle: fromWord });
      const [b] = await call("search", { docId, needle: toWord });
      const point = (q: number[], t: number): [number, number] => [
        (q[0] + q[4]) / 2 + (((q[2] + q[6]) - (q[0] + q[4])) / 2) * t,
        (q[1] + q[5]) / 2 + (((q[3] + q[7]) - (q[1] + q[5])) / 2) * t,
      ];
      const sel = await call("selectText", {
        docId,
        page: a.page,
        from: point(a.quads[0], along),
        to: point(b.quads[b.quads.length - 1], along),
        mode: "words",
      });
      return sel.text.replace(/\s+/g, " ").trim();
    } finally {
      await call("close", { docId });
    }
  }

  it("a double click selects exactly the word, wherever it is clicked", async () => {
    for (const along of [0.1, 0.5, 0.95]) {
      // the last word of a line must not take the first word of the next line
      expect(await selectWords("demo-en.pdf", "Corvids", "Corvids", along)).toBe("Corvids");
      expect(await selectWords("demo-en.pdf", "relatives", "relatives", along)).toBe("relatives");
      // words separated only by gaps, not by space characters
      expect(await selectWords("sample.pdf", "kopretina", "kopretina", along)).toBe("kopretina");
      expect(await selectWords("form.pdf", "registration", "registration", along)).toBe("registration");
      // a page rotated by 90°
      expect(await selectWords("form.pdf", "faces", "faces", along)).toBe("faces");
    }
  });

  it("dragging after a double click extends the selection by whole words", async () => {
    expect(await selectWords("demo-en.pdf", "short", "ravens")).toBe("short field guide to crows, ravens");
  });

  it("selects nothing far away from the text", async () => {
    const { docId } = await open("form.pdf");
    const sel = await call("selectText", { docId, page: 0, from: [300, 790], to: [300, 790], mode: "words" });
    expect(sel.text).toBe("");
    await call("close", { docId });
  });
});
