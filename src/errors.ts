import { EngineError } from "./engine/types";
import { msg } from "./i18n";

/** Human readable, localized text of an error (engine error codes are translated). */
export function errorText(e: unknown): string {
  if (e instanceof EngineError && e.code) {
    const known = msg().errors[e.code];
    if (known) return known.replace("%s", e.detail ?? "");
  }
  const text = e instanceof Error ? e.message : String(e);
  // Electron wraps errors thrown in the main process: "Error invoking remote method 'x': Error: message"
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
