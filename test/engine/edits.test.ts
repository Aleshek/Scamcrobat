// Form filling, comments, undo/redo and saving them into the file.
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import type { Quad } from "../../src/engine/types";
import { call, fixture, open, reopen, revisions, startsWith } from "./harness";

/** A small PNG (a page of a demo document) to use as a signature image. */
function pngImage(): Uint8Array {
  const doc = mupdf.Document.openDocument(fixture("demo-en.pdf"), "application/pdf");
  return doc.loadPage(0).toPixmap(mupdf.Matrix.scale(0.2, 0.2), mupdf.ColorSpace.DeviceRGB, false).asPNG();
}

function fieldValues(doc: mupdf.PDFDocument, page: number): Record<string, string> {
  return Object.fromEntries(
    doc
      .loadPage(page)
      .getWidgets()
      .map((w) => [w.getName(), w.getValue()]),
  );
}

function annotTypes(doc: mupdf.PDFDocument, page: number): string[] {
  return doc
    .loadPage(page)
    .getAnnotations()
    .map((a) => a.getType())
    .filter((t) => t !== "Widget" && t !== "Link" && t !== "Popup")
    .sort();
}

describe("forms", () => {
  it("fills in fields and saves them incrementally", async () => {
    const original = fixture("form.pdf");
    const { docId } = await open("form.pdf");
    const { widgets } = await call("pageExtras", { docId, page: 0 });
    const byName = (name: string) => widgets.find((w) => w.name === name)!;
    expect(byName("name").kind).toBe("text");
    expect(byName("group").kind).toBe("combobox");
    expect(byName("binoculars").kind).toBe("checkbox");

    await call("setField", { docId, page: 0, id: byName("name").id, value: "Jana Nováková" });
    await call("setField", { docId, page: 0, id: byName("group").id, value: "3" });
    const state = await call("setField", { docId, page: 0, id: byName("binoculars").id, toggle: true });
    expect(state.canUndo).toBe(true);

    const saved = await call("getBytes", { docId });
    // the original stays byte for byte, the changes are appended
    expect(startsWith(saved, original)).toBe(true);
    const values = fieldValues(reopen(saved), 0);
    expect(values.name).toBe("Jana Nováková");
    expect(values.group).toBe("3");
    expect(values.binoculars).toBe("Yes");
    await call("close", { docId });
  });
});

describe("comments", () => {
  it("creates every kind of comment and saves them", async () => {
    const { docId } = await open("demo-en.pdf");
    const [hit] = await call("search", { docId, needle: "Corvids" });
    const red: [number, number, number] = [1, 0, 0];
    const page = hit.page;
    await call("editAnnot", { docId, page, edit: { op: "create", annot: { type: "Highlight", quads: hit.quads, color: [1, 1, 0] } } });
    await call("editAnnot", { docId, page, edit: { op: "create", annot: { type: "Underline", quads: hit.quads, color: red } } });
    await call("editAnnot", { docId, page, edit: { op: "create", annot: { type: "Text", rect: [40, 40, 60, 60], text: "Poznámka", color: [1, 0.8, 0] } } });
    await call("editAnnot", {
      docId,
      page,
      edit: { op: "create", annot: { type: "FreeText", rect: [60, 400, 300, 430], text: "Příliš žluťoučký kůň", color: red, size: 14 } },
    });
    await call("editAnnot", {
      docId,
      page,
      edit: { op: "create", annot: { type: "Ink", strokes: [[[100, 500], [150, 520], [200, 500]]], color: red, width: 2 } },
    });
    const sig = await call("editAnnot", {
      docId,
      page,
      edit: { op: "create", annot: { type: "Stamp", rect: [300, 600, 450, 660], image: pngImage() } },
    });
    expect(sig.id).toBeTypeOf("number");

    const { annots } = await call("pageExtras", { docId, page });
    expect(annots.map((a) => a.type).sort()).toEqual(["FreeText", "Highlight", "Ink", "Stamp", "Text", "Underline"]);
    expect(annots.find((a) => a.type === "FreeText")!.contents).toBe("Příliš žluťoučký kůň");

    const saved = await call("getBytes", { docId });
    expect(annotTypes(reopen(saved), page)).toEqual(["FreeText", "Highlight", "Ink", "Stamp", "Text", "Underline"]);
    await call("close", { docId });
  });

  it("moves, recolors and deletes a comment; undo and redo", async () => {
    const { docId } = await open("demo-en.pdf");
    const created = await call("editAnnot", {
      docId,
      page: 1,
      edit: { op: "create", annot: { type: "FreeText", rect: [100, 100, 200, 120], text: "Hello", color: [0, 0, 0], size: 12 } },
    });
    const id = created.id!;
    const rectOf = async () => (await call("pageExtras", { docId, page: 1 })).annots.find((a) => a.id === id)?.rect;

    await call("editAnnot", { docId, page: 1, edit: { op: "move", id, dx: 50, dy: 20 } });
    expect((await rectOf())![0]).toBeCloseTo(150, 0);
    await call("editAnnot", { docId, page: 1, edit: { op: "setColor", id, color: [0, 0, 1] } });
    await call("editAnnot", { docId, page: 1, edit: { op: "delete", id } });
    expect(await rectOf()).toBeUndefined();

    let state = await call("undo", { docId }); // the deletion
    expect(await rectOf()).toBeDefined();
    expect(state.canRedo).toBe(true);
    state = await call("redo", { docId });
    expect(await rectOf()).toBeUndefined();
    for (let i = 0; i < 3; i++) state = await call("undo", { docId });
    expect(state.canUndo).toBe(true); // the creation itself
    state = await call("undo", { docId });
    expect(state.canUndo).toBe(false);
    expect((await call("pageExtras", { docId, page: 1 })).annots).toEqual([]);
    await call("close", { docId });
  });

  it("a second save keeps the changes of the first one", async () => {
    // After a save MuPDF takes the document as saved; the engine reopens it from the
    // saved bytes, so the next incremental save does not lose anything.
    const { docId } = await open("demo-en.pdf");
    const note = (y: number) =>
      call("editAnnot", { docId, page: 0, edit: { op: "create", annot: { type: "Text", rect: [40, y, 60, y + 20], text: `note ${y}`, color: [1, 1, 0] } } });
    await note(100);
    const first = await call("getBytes", { docId });
    await note(200);
    const second = await call("getBytes", { docId });
    expect(startsWith(second, first)).toBe(true);
    expect(revisions(second)).toBe(revisions(first) + 1);
    expect(annotTypes(reopen(second), 0)).toEqual(["Text", "Text"]);
    // a save also starts a new undo history
    expect((await call("history", { docId })).canUndo).toBe(false);
    await call("close", { docId });
  });
});

describe("blacking out (redaction)", () => {
  it("removes the text for good and writes the whole file again", async () => {
    const original = fixture("sample.pdf");
    const { docId } = await open("sample.pdf");
    const hits = await call("search", { docId, needle: "kopretina" });
    const onFirst = hits.filter((h) => h.page === 0);
    await call("redact", { docId, page: 0, area: { quads: onFirst.flatMap((h) => h.quads) as Quad[] } });

    const saved = await call("getBytes", { docId });
    // an incremental save would keep the old content in the file
    expect(startsWith(saved, original)).toBe(false);
    expect(revisions(saved)).toBe(1);
    const doc = reopen(saved);
    expect(doc.loadPage(0).toStructuredText("").asText()).not.toMatch(/kopretina/);
    expect(doc.loadPage(1).toStructuredText("").asText()).toMatch(/kopretina/);
    await call("close", { docId });
  });

  it("blacks out a rectangle", async () => {
    const { docId } = await open("demo-en.pdf");
    const [hit] = await call("search", { docId, needle: "Antarctica" });
    const q = hit.quads[0];
    await call("redact", { docId, page: hit.page, area: { rect: [q[0] - 1, q[1] - 1, q[6] + 1, q[7] + 1] } });
    expect(await call("search", { docId, needle: "Antarctica" })).toEqual([]);
    // undo brings it back while the document is open
    await call("undo", { docId });
    expect(await call("search", { docId, needle: "Antarctica" })).toHaveLength(1);
    await call("close", { docId });
  });
});

describe("correcting text", () => {
  it("replaces a line, keeping Czech letters", async () => {
    const { docId } = await open("sample.pdf");
    const lines = await call("textLines", { docId, page: 0 });
    const line = lines.find((l) => l.text.includes("kopretina"))!;
    expect(line.horizontal).toBe(true);
    await call("editText", { docId, page: 0, line, text: line.text.replace("kopretina", "sedmikráska") });

    const saved = await call("getBytes", { docId });
    expect(revisions(saved)).toBe(1);
    const text = reopen(saved).loadPage(0).toStructuredText("").asText();
    expect(text).toMatch(/hledané slovo sedmikráska na straně 1/);
    expect(text).not.toMatch(/Řádek 1: hledané slovo kopretina/);
    // the other lines stay as they were
    expect(text).toMatch(/Řádek 5: hledané slovo kopretina na straně 1/);
    await call("close", { docId });
  });
});
