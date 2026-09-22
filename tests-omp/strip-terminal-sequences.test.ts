/**
 * Standalone tests for the vendored terminal-sequence stripper.
 *
 * Runs outside omp (`bun test tests-omp/`) because the compat module has no
 * host imports. The cases cover the three sequence classes pi emits, including
 * the APC cursor marker that a CSI-only regex would leak into rendered output.
 */
import { describe, expect, test } from "bun:test";
import {
  extractAnsiCode,
  stripTerminalSequences,
} from "../src/compat/strip-terminal-sequences.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

describe("stripTerminalSequences", () => {
  test("passes through text with no escapes", () => {
    expect(stripTerminalSequences("plain text")).toBe("plain text");
    expect(stripTerminalSequences("")).toBe("");
  });

  test("strips CSI styling and cursor sequences", () => {
    expect(stripTerminalSequences(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripTerminalSequences(`${ESC}[2J${ESC}[Hcleared`)).toBe("cleared");
  });

  test("strips OSC 8 hyperlinks with both terminators", () => {
    expect(stripTerminalSequences(`${ESC}]8;;https://x.dev${BEL}link${ESC}]8;;${BEL}`)).toBe(
      "link",
    );
    expect(stripTerminalSequences(`${ESC}]8;;https://x.dev${ST}link${ESC}]8;;${ST}`)).toBe("link");
  });

  test("strips APC sequences such as pi's cursor marker", () => {
    expect(stripTerminalSequences(`${ESC}_pi:c${BEL}after`)).toBe("after");
    expect(stripTerminalSequences(`${ESC}_pi:c${ST}after`)).toBe("after");
  });

  test("preserves visible text mixed with sequences", () => {
    const input = `${ESC}[1m${ESC}]8;;https://x.dev${BEL}bold link${ESC}]8;;${BEL}${ESC}[0m tail`;
    expect(stripTerminalSequences(input)).toBe("bold link tail");
  });

  test("keeps non-escape control characters and unicode", () => {
    expect(stripTerminalSequences("a\tb\nc")).toBe("a\tb\nc");
    expect(stripTerminalSequences(`${ESC}[32m✓ 日本語${ESC}[0m`)).toBe("✓ 日本語");
  });

  test("leaves a truncated sequence alone rather than dropping text", () => {
    // Unterminated CSI: no final byte in [mGKHJ], so nothing is recognized.
    expect(stripTerminalSequences(`${ESC}[31`)).toBe(`${ESC}[31`);
  });
});

describe("extractAnsiCode", () => {
  test("returns null off an escape", () => {
    expect(extractAnsiCode("abc", 0)).toBeNull();
    expect(extractAnsiCode("", 0)).toBeNull();
  });

  test("reports the code and its length", () => {
    const csi = extractAnsiCode(`${ESC}[31mx`, 0);
    expect(csi).toEqual({ code: `${ESC}[31m`, length: 5 });

    const apc = extractAnsiCode(`${ESC}_pi:c${BEL}x`, 0);
    expect(apc).toEqual({ code: `${ESC}_pi:c${BEL}`, length: 7 });
  });
});