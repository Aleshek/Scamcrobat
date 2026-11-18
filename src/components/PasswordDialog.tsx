import { useState } from "react";
import { Lock } from "lucide-react";
import { Modal } from "./Modal";
import { useT } from "../i18n";

interface Props {
  fileName: string;
  /** The previous attempt was wrong */
  wrong: boolean;
  /** The password to open the document, or its permissions password (to lift its restrictions) */
  kind?: "open" | "permissions";
  onSubmit(password: string): void;
  onClose(): void;
}

export function PasswordDialog(props: Props) {
  const t = useT();
  const [value, setValue] = useState("");
  const permissions = props.kind === "permissions";
  const name = <strong>{props.fileName}</strong>;
  return (
    <Modal
      title={permissions ? t.restrictions.pagesTitle : t.app.passwordTitle}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t.common.cancel}
          </button>
          <button className="btn primary" disabled={!value} onClick={() => props.onSubmit(value)}>
            {permissions ? t.protect.unlock : t.common.open}
          </button>
        </>
      }
    >
      <div className="password-row">
        <Lock size={20} className="muted" />
        <p>{permissions ? t.restrictions.pagesPrompt(name) : t.app.passwordPrompt(name)}</p>
      </div>
      <input
        className={props.wrong ? "input wide invalid" : "input wide"}
        type="password"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value && props.onSubmit(value)}
        aria-label={permissions ? t.protect.permissionsPassword : t.app.password}
      />
      {props.wrong && <p className="hint error">{t.app.wrongPassword}</p>}
    </Modal>
  );
}
