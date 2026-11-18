/** An engine error with a `code` that the UI translates; the message is only for logs. */
export class CodedError extends Error {
  code: string;
  /** Extra detail for the translated message (e.g. the character that cannot be written) */
  detail?: string;

  constructor(message: string, code: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
