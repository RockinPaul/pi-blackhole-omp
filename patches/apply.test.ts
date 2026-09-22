/**
 * Tests for the patch pipeline's decision logic.
 *
 * The patches must do three different things depending on what upstream ships:
 * apply (still broken), retire (fixed upstream), or fail loudly (reshaped so we
 * cannot tell). A patch that silently no-ops on a reshaped target is how a fork
 * ends up shipping broken code, so all three paths are pinned here against
 * minimal fixtures — no network, no tarball.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatchError, patchReceiverBind, patchTerminalSequences } from "./apply.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = join(tmpdir(), `bh-patch-test-${roots.length}-${Date.now()}`);
  mkdirSync(join(root, "src/hooks"), { recursive: true });
  roots.push(root);
  return root;
}

function writeFixture(root: string, file: string, content: string): string {
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const UPSTREAM_TUI_IMPORT =
  'import { Container, Markdown, Text, stripTerminalSequences } from "@earendil-works/pi-tui";';

describe("patchTerminalSequences", () => {
  test("applies on the upstream shape and vendors the module", () => {
    const root = makeRoot();
    const file = writeFixture(
      root,
      "src/hooks/cosmetic-output.ts",
      `${UPSTREAM_TUI_IMPORT}\nconst bounded = stripTerminalSequences(text);\n`,
    );

    expect(patchTerminalSequences(root)).toBe("applied");

    const patched = readFileSync(file, "utf8");
    expect(patched).toContain('import { Container, Markdown, Text } from "@earendil-works/pi-tui";');
    expect(patched).toContain(
      'import { stripTerminalSequences } from "../compat/strip-terminal-sequences.js";',
    );
    expect(patched).not.toContain('stripTerminalSequences } from "@earendil-works/pi-tui"');

    const vendored = join(root, "src/compat/strip-terminal-sequences.ts");
    expect(existsSync(vendored)).toBe(true);
    expect(readFileSync(vendored, "utf8")).toContain("export function stripTerminalSequences");
  });

  test("retires when upstream stopped using the symbol", () => {
    const root = makeRoot();
    writeFixture(
      root,
      "src/hooks/cosmetic-output.ts",
      'import { Container, Markdown, Text } from "@earendil-works/pi-tui";\nconst bounded = text;\n',
    );

    expect(patchTerminalSequences(root)).toBe("retired");
    expect(existsSync(join(root, "src/compat"))).toBe(false);
  });

  test("fails when the symbol is still used but the import was reshaped", () => {
    const root = makeRoot();
    writeFixture(
      root,
      "src/hooks/cosmetic-output.ts",
      'import * as tui from "@earendil-works/pi-tui";\nconst bounded = stripTerminalSequences(text);\n',
    );

    expect(() => patchTerminalSequences(root)).toThrow(PatchError);
    expect(() => patchTerminalSequences(root)).toThrow(/reshaped/);
  });

  test("fails when the target file disappeared", () => {
    const root = makeRoot();
    expect(() => patchTerminalSequences(root)).toThrow(PatchError);
  });
});

describe("patchReceiverBind", () => {
  const UPSTREAM = [
    "export function registerCompactFailedHook(pi, runtime) {",
    "  const onAny = pi.on as unknown as (",
    '    event: string,',
    "  ) => void;",
    '  onAny("session_compact_failed", () => {});',
    "}",
  ].join("\n");

  test("applies on the upstream shape", () => {
    const root = makeRoot();
    const file = writeFixture(root, "src/hooks/compact-failed.ts", UPSTREAM);

    expect(patchReceiverBind(root)).toBe("applied");

    const patched = readFileSync(file, "utf8");
    expect(patched).toContain("const onAny = pi.on.bind(pi) as unknown as (");
    expect(patched).not.toContain("const onAny = pi.on as unknown as (");
  });

  test("retires when upstream already binds", () => {
    const root = makeRoot();
    writeFixture(
      root,
      "src/hooks/compact-failed.ts",
      UPSTREAM.replace("pi.on as unknown as", "pi.on.bind(pi) as unknown as"),
    );

    expect(patchReceiverBind(root)).toBe("retired");
  });

  test("fails when the registration was reshaped", () => {
    const root = makeRoot();
    writeFixture(
      root,
      "src/hooks/compact-failed.ts",
      'export function registerCompactFailedHook(pi) {\n  pi.on("session_compact_failed", () => {});\n}\n',
    );

    expect(() => patchReceiverBind(root)).toThrow(PatchError);
    expect(() => patchReceiverBind(root)).toThrow(/target not found/);
  });
});