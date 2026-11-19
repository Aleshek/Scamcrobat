// Password protection: encrypting on save, opening protected documents, restrictions.
import { describe, expect, it } from "vitest";
import { call, EngineFailure, open, reopen, revisions } from "./harness";

const OPEN = "kavka";
const OWNER = "krkavec";

/** demo-en.pdf saved with an open password and no printing, copying or editing. */
async function protectedDemo(): Promise<Uint8Array> {
  const { docId } = await open("demo-en.pdf");
  await call("protect", {
    docId,
    protection: { openPassword: OPEN, permissionsPassword: OWNER, permissions: { print: false, copy: false, edit: false } },
  });
  const bytes = await call("getBytes", { docId });
  await call("close", { docId });
  return bytes;
}

describe("password protection", () => {
  it("encrypts the whole file with the passwords and restrictions", async () => {
    const bytes = await protectedDemo();
    expect(revisions(bytes)).toBe(1);
    expect(() => reopen(bytes)).toThrow();
    expect(() => reopen(bytes, "wrong")).toThrow();

    const asUser = reopen(bytes, OPEN);
    expect(asUser.countPages()).toBe(6);
    expect(asUser.hasPermission("print")).toBe(false);
    expect(asUser.hasPermission("copy")).toBe(false);

    const asOwner = reopen(bytes, OWNER);
    expect(asOwner.hasPermission("print")).toBe(true);
  });

  it("asks for the password and keeps the restrictions", async () => {
    const bytes = await protectedDemo();
    await expect(open(bytes)).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    await expect(open(bytes, "wrong")).rejects.toMatchObject({ code: "PASSWORD_WRONG" });

    const { docId } = await open(bytes, OPEN);
    const info = await call("security", { docId });
    expect(info.openPassword).toBe(true);
    expect(info.method).toMatch(/AES/);
    expect(info.rights.print).toBe(false);
    expect(info.rights.modify).toBe(false);
    expect(info.canChange).toBe(false);

    // restricted: no blacking out, no changing the protection
    await expect(call("redact", { docId, page: 0, area: { rect: [0, 0, 100, 100] } })).rejects.toBeInstanceOf(EngineFailure);
    await expect(call("protect", { docId, protection: null })).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    await expect(call("unlock", { docId, password: "wrong" })).rejects.toMatchObject({ code: "PASSWORD_WRONG" });

    // the permissions password lifts the restrictions and allows removing the protection
    const unlocked = await call("unlock", { docId, password: OWNER });
    expect(unlocked.canChange).toBe(true);
    expect(unlocked.rights.modify).toBe(true);
    await call("protect", { docId, protection: null });
    const plain = await call("getBytes", { docId });
    const doc = reopen(plain);
    expect(doc.needsPassword()).toBe(false);
    expect(doc.hasPermission("print")).toBe(true);
    await call("close", { docId });
  });
});
