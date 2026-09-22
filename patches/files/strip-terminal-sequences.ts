/**
 * Terminal-sequence stripping, vendored from pi-mono.
 *
 * Why this file exists: `@earendil-works/pi-tui` exports `stripTerminalSequences`
 * (packages/tui/src/utils.ts), but hosts that bundle an older pi-tui snapshot —
 * notably omp, whose fork predates the symbol — cannot resolve it. Importing it
 * from the host package therefore breaks extension loading on those hosts.
 *
 * The implementation below is copied verbatim from pi-mono
 * `packages/tui/src/utils.ts` (`stripTerminalSequences` + its `extractAnsiCode`
 * helper) so behavior is byte-identical on every host. It has no imports, which
 * keeps it testable standalone with `bun test`.
 *
 * Handles all three sequence classes pi emits:
 *  - CSI  `ESC [ … m/G/K/H/J`   (SGR styling, cursor, erase)
 *  - OSC  `ESC ] … BEL|ST`      (hyperlinks, window titles)
 *  - APC  `ESC _ … BEL|ST`      (pi's CURSOR_MARKER, e.g. `ESC _pi:c BEL`)
 * A CSI-only regex would leak OSC/APC into rendered output.
 */

/** Detect an ANSI/OSC/APC escape sequence starting at `pos`. */
export function extractAnsiCode(
  str: string,
  pos: number,
): { code: string; length: number } | null {
  if (pos >= str.length || str[pos] !== "\x1b") return null;

  const next = str[pos + 1];

  // CSI sequence: ESC [ ... m/G/K/H/J
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
    if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
    return null;
  }

  // OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
  // Used for hyperlinks (OSC 8), window titles, etc.
  if (next === "]") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\")
        return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }

  // APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
  // Used for cursor marker and application-specific commands
  if (next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\")
        return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }

  return null;
}

/** Remove ANSI, OSC, and APC control sequences while preserving visible text. */
export function stripTerminalSequences(str: string): string {
  if (!str.includes("\x1b")) return str;
  let result = "";
  let i = 0;
  while (i < str.length) {
    const ansi = extractAnsiCode(str, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    result += str[i];
    i++;
  }
  return result;
}