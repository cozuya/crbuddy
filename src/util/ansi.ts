const ANSI =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const OSC = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const UNTERMINATED_OSC_LINE = /\x1B\][^\r\n]*/g;

// Preserve tab/newline/CR for callers that intentionally handle layout. Strip
// the rest of C0/C1 plus any escape sequence our ANSI matcher did not consume.
// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Some CLIs emit color even when piped; markdown should not carry it. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI, '');
}

/** Remove terminal-control sequences while preserving ordinary text layout. */
export function stripTerminalControls(input: string): string {
  return stripAnsi(input.replace(OSC, '').replace(UNTERMINATED_OSC_LINE, ''))
    .replace(/\x1B./g, '')
    .replace(OTHER_CONTROLS, '');
}

/** Safe one-line rendering for config-controlled terminal summaries. */
export function sanitizeTerminalInline(input: string): string {
  return stripTerminalControls(input)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}
