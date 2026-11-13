import type { ReactNode } from "react";
import { Modal } from "./Modal";

export interface ChoiceOption {
  value: string;
  label: string;
  kind?: "primary" | "danger";
}

export interface ChoiceRequest {
  title: string;
  message: ReactNode;
  /** Tlačítka zleva doprava; zavření dialogu vrací "cancel". */
  options: ChoiceOption[];
}

export function ChoiceDialog({ request, onChoose }: { request: ChoiceRequest; onChoose(value: string): void }) {
  return (
    <Modal
      title={request.title}
      onClose={() => onChoose("cancel")}
      footer={request.options.map((o) => (
        <button key={o.value} className={o.kind ? `btn ${o.kind}` : "btn"} onClick={() => onChoose(o.value)}>
          {o.label}
        </button>
      ))}
    >
      <div className="choice-message">{request.message}</div>
    </Modal>
  );
}
