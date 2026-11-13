import { useState } from "react";
import { Lock } from "lucide-react";
import { Modal } from "./Modal";
import { useT } from "../i18n";

interface Props {
  fileName: string;
  /** The previous attempt was wrong */
  wrong: boolean;
  onSubmit(password: string): void;
  onClose(): void;
}

export function PasswordDialog(props: Props) {
  const t = useT();
  const [value, setValue] = useState("");
  return (
    <Modal
      title={t.app.passwordTitle}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t.common.cancel}
          </button>
          <button className="btn primary" disabled={!value} onClick={() => props.onSubmit(value)}>
            {t.common.open}
          </button>
        </>
      }
    >
      <div className="password-row">
        <Lock size={20} className="muted" />
        <p>{t.app.passwordPrompt(<strong>{props.fileName}</strong>)}</p>
      </div>
      <input
        className={props.wrong ? "input wide invalid" : "input wide"}
        type="password"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value && props.onSubmit(value)}
        aria-label={t.app.password}
      />
      {props.wrong && <p className="hint error">{t.app.wrongPassword}</p>}
    </Modal>
  );
}
