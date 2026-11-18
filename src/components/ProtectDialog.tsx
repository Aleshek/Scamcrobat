/**
 * Password protection of a document: a password to open it, and restrictions of
 * printing, copying and changes guarded by a permissions password. The protection is
 * applied (AES-256) when the document is saved.
 */
import { useEffect, useState } from "react";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import type { PdfEngine } from "../engine/engine";
import type { Permissions, Protection, SecurityInfo } from "../engine/types";
import { errorText } from "../errors";
import { useT } from "../i18n";
import { Modal } from "./Modal";

interface Props {
  engine: PdfEngine;
  docId: number;
  /**
   * Only lift the restrictions with the permissions password: the dialog closes once
   * the password is accepted (otherwise it continues with changing the protection).
   */
  unlockOnly?: boolean;
  /** The protection was changed; `message` says when it takes effect. */
  onChanged(message: string): void;
  /** New state of the protection (after unlocking or a change). */
  onSecurity(info: SecurityInfo): void;
  /** The restrictions were lifted with the permissions password. */
  onUnlocked(): void;
  onClose(): void;
}

const ALL: Permissions = { print: true, copy: true, edit: true };

export function ProtectDialog({ engine, docId, unlockOnly, onChanged, onSecurity, onUnlocked, onClose }: Props) {
  const t = useT();
  const p = t.protect;
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [unlockPassword, setUnlockPassword] = useState("");
  const [requireOpen, setRequireOpen] = useState(false);
  const [openPassword, setOpenPassword] = useState("");
  const [openConfirm, setOpenConfirm] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [permPassword, setPermPassword] = useState("");
  const [permConfirm, setPermConfirm] = useState("");
  const [allowed, setAllowed] = useState<Permissions>({ print: true, copy: false, edit: false });
  const [tried, setTried] = useState(false);

  /** Fills the form from the current (or pending) protection. */
  const load = (s: SecurityInfo) => {
    setInfo(s);
    const pending = s.pending;
    if (pending !== undefined) {
      setRequireOpen(!!pending?.openPassword);
      setRestrict(!!pending?.permissionsPassword);
      if (pending?.permissionsPassword) setAllowed(pending.permissions);
    } else {
      setRequireOpen(s.openPassword);
      const restricted = !s.permissions.print || !s.permissions.copy || !s.permissions.edit;
      setRestrict(s.method !== null && (restricted || !s.canChange));
      if (restricted) setAllowed(s.permissions);
    }
  };

  useEffect(() => {
    engine.security(docId).then(load, (e) => setError(errorText(e)));
  }, [engine, docId]);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const unlocked = await engine.unlock(docId, unlockPassword);
      onSecurity(unlocked);
      onUnlocked();
      if (unlockOnly) {
        onClose();
        return;
      }
      load(unlocked);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const openError = !requireOpen
    ? null
    : !openPassword
      ? p.empty
      : openPassword !== openConfirm
        ? p.mismatch
        : null;
  const permError = !restrict
    ? null
    : !permPassword
      ? p.empty
      : permPassword !== permConfirm
        ? p.mismatch
        : requireOpen && permPassword === openPassword
          ? p.samePasswords
          : null;

  const submit = async (protection: Protection | null) => {
    setBusy(true);
    setError(null);
    try {
      onSecurity(await engine.protect(docId, protection));
      onChanged(protection ? p.applied : p.removed);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const apply = () => {
    setTried(true);
    if (openError || permError) return;
    if (!requireOpen && !restrict) {
      void submit(null);
      return;
    }
    void submit({
      openPassword: requireOpen ? openPassword : "",
      permissionsPassword: restrict ? permPassword : "",
      permissions: restrict ? allowed : ALL,
    });
  };

  const protectedNow = !!info?.method;
  const canRemove = protectedNow || !!info?.pending;
  const locked = !!info && !info.canChange;

  /** Current state of the document in words. */
  const status = () => {
    if (!info) return null;
    if (info.pending === null) return p.pendingRemove;
    if (info.pending) return p.pending;
    if (!info.method) return p.none;
    const denied = [
      !info.permissions.print && p.printing,
      !info.permissions.copy && p.copying,
      !info.permissions.edit && p.changes,
    ].filter(Boolean);
    return [p.current(info.method), info.openPassword && p.needsOpen, denied.length > 0 && p.restricted(denied.join(", "))]
      .filter(Boolean)
      .join(" ");
  };

  const passwordPair = (
    value: string,
    setValue: (v: string) => void,
    confirm: string,
    setConfirm: (v: string) => void,
    error: string | null,
    label: string,
  ) => (
    <div className="protect-fields">
      <input
        className={tried && error && !value ? "input wide invalid" : "input wide"}
        type="password"
        value={value}
        placeholder={label}
        aria-label={label}
        autoComplete="new-password"
        onChange={(e) => setValue(e.target.value)}
      />
      <input
        className={tried && error && value ? "input wide invalid" : "input wide"}
        type="password"
        value={confirm}
        placeholder={p.confirm}
        aria-label={p.confirm}
        autoComplete="new-password"
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
      />
      {tried && error && <p className="hint error">{error}</p>}
    </div>
  );

  return (
    <Modal
      title={unlockOnly ? t.restrictions.dialogTitle : p.title}
      onClose={onClose}
      footer={
        locked ? (
          <>
            <button className="btn" onClick={onClose}>
              {t.common.cancel}
            </button>
            <button className="btn primary" disabled={!unlockPassword || busy} onClick={() => void unlock()}>
              {p.unlock}
            </button>
          </>
        ) : (
          <>
            {canRemove && (
              <button className="btn danger protect-remove" disabled={!info || busy} onClick={() => void submit(null)}>
                {p.remove}
              </button>
            )}
            <button className="btn" onClick={onClose}>
              {t.common.cancel}
            </button>
            <button className="btn primary" disabled={!info || busy} onClick={apply}>
              {p.apply}
            </button>
          </>
        )
      }
    >
      <div className="password-row">
        {protectedNow ? <LockKeyhole size={20} className="muted" /> : <ShieldCheck size={20} className="muted" />}
        <p>{status()}</p>
      </div>
      {error && <p className="alert">{error}</p>}

      {locked ? (
        <>
          <p className="hint">{unlockOnly ? t.restrictions.dialogPrompt : p.locked}</p>
          <input
            className="input wide"
            type="password"
            value={unlockPassword}
            autoFocus
            aria-label={p.permissionsPassword}
            placeholder={p.permissionsPassword}
            onChange={(e) => setUnlockPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlockPassword && void unlock()}
          />
        </>
      ) : (
        info && (
          <>
            <label className="checkbox">
              <input type="checkbox" checked={requireOpen} onChange={(e) => setRequireOpen(e.target.checked)} />
              {p.requireOpen}
            </label>
            {requireOpen && passwordPair(openPassword, setOpenPassword, openConfirm, setOpenConfirm, openError, p.password)}

            <label className="checkbox">
              <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
              {p.restrict}
            </label>
            {restrict && (
              <>
                {passwordPair(permPassword, setPermPassword, permConfirm, setPermConfirm, permError, p.permissionsPassword)}
                <div className="protect-perms">
                  {(
                    [
                      ["print", p.allowPrint],
                      ["copy", p.allowCopy],
                      ["edit", p.allowEdit],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="checkbox">
                      <input
                        type="checkbox"
                        checked={allowed[key]}
                        onChange={(e) => setAllowed({ ...allowed, [key]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="hint">{p.restrictNote}</p>
              </>
            )}
            <p className="hint">{p.note}</p>
          </>
        )
      )}
    </Modal>
  );
}
