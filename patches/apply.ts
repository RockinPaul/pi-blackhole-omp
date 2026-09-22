#!/usr/bin/env bun
/**
 * Regenerate this fork's plugin tree from an upstream npm release.
 *
 * The fork is a *generated* artifact: upstream's published tarball plus the
 * patches below. This script is the source of truth — never hand-edit the
 * plugin tree, or the next resync silently drops your change.
 *
 *   bun patches/apply.ts --version 0.5.8
 *   bun patches/apply.ts                      # resolves "latest" from npm
 *   bun patches/apply.ts --version 0.5.8 --verify-load
 *
 * Every patch asserts its precondition and fails loudly (non-zero exit, tree
 * left untouched) if upstream reshaped the target. A silent no-op patch is the
 * failure mode this script exists to prevent.
 *
 * The result is built in a temp dir, tested, and only then copied over the repo
 * root. Repo-owned paths (see PRESERVE) are never touched.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const VENDOR_FILES = join(import.meta.dir, "files");
const PKG = "pi-blackhole";

/** Repo-owned paths that a resync must never delete or overwrite. */
const PRESERVE = [".git", ".github", ".gitignore", "README.md", "patches", "tests-omp"];

// ── cli ─────────────────────────────────────────────────────────────────────

interface Options {
  version: string;
  force: boolean;
  verifyLoad: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { version: "latest", force: false, verifyLoad: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") {
      const value = argv[++i];
      if (value === undefined) fail("--version needs a value");
      opts.version = value;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--verify-load") {
      opts.verifyLoad = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Expected, explainable failure. Thrown rather than exit-ed so `main`'s finally
 * still cleans the staging dir — process.exit() skips finally blocks, which is
 * how a failed run once left a full staging tree behind to be committed.
 */
export class PatchError extends Error {}

function fail(message: string): never {
  throw new PatchError(message);
}

function step(message: string): void {
  console.log(`→ ${message}`);
}

// ── upstream fetch ──────────────────────────────────────────────────────────

async function resolveVersion(spec: string): Promise<string> {
  if (spec !== "latest") return spec;
  const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`);
  if (!res.ok) fail(`npm registry returned ${res.status} for ${PKG}/latest`);
  const meta = (await res.json()) as { version?: unknown };
  if (typeof meta.version !== "string") fail("npm registry response has no version");
  return meta.version;
}

async function downloadTarball(version: string, destDir: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${PKG}/${version}`);
  if (!res.ok) fail(`npm registry returned ${res.status} for ${PKG}/${version}`);
  const meta = (await res.json()) as { dist?: { tarball?: unknown } };
  const url = meta.dist?.tarball;
  if (typeof url !== "string") fail(`no dist.tarball for ${PKG}@${version}`);

  const tarball = join(destDir, `${PKG}-${version}.tgz`);
  const file = await fetch(url);
  if (!file.ok) fail(`tarball download failed: ${file.status}`);
  writeFileSync(tarball, Buffer.from(await file.arrayBuffer()));
  return tarball;
}

function extract(tarball: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const proc = Bun.spawnSync(["tar", "xzf", tarball, "-C", dest, "--strip-components=1"], {
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    fail(`tar extraction failed: ${proc.stderr.toString().trim()}`);
  }
}

// ── patch primitives ────────────────────────────────────────────────────────

function readText(path: string): string {
  if (!existsSync(path)) fail(`expected file missing from upstream tarball: ${rel(path)}`);
  return readFileSync(path, "utf8");
}

function writeText(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function rel(path: string): string {
  return relative(REPO_ROOT, path) || path;
}

/** Replace exactly one occurrence; anything else is an upstream reshape. */
function replaceOnce(file: string, needle: string, replacement: string, label: string): void {
  const source = readText(file);
  const occurrences = source.split(needle).length - 1;
  if (occurrences === 0) fail(`${label}: target not found in ${rel(file)} — upstream reshaped it`);
  if (occurrences > 1) fail(`${label}: target appears ${occurrences}× in ${rel(file)} — ambiguous`);
  writeText(file, source.replace(needle, replacement));
  step(`patched ${label}`);
}

// ── patches ─────────────────────────────────────────────────────────────────

/** Whether a compat patch still had work to do on this upstream release. */
export type PatchOutcome = "applied" | "retired";

/**
 * P1+P2 — vendor `stripTerminalSequences` and point cosmetic-output.ts at it.
 *
 * Upstream imports the symbol from `@earendil-works/pi-tui`. omp rewrites that
 * specifier onto its own bundled pi-tui, which does not export it, so the
 * extension fails omp's install-time validation gate. The vendored copy is
 * byte-identical to pi-mono's, so pi behavior is unchanged.
 *
 * Self-retiring: if upstream stops using the symbol, this reports `retired` and
 * the vendor file is not written. Once omp ships the export
 * (can1357/oh-my-pi#12795) the patch is redundant but still harmless.
 */
export function patchTerminalSequences(root: string): PatchOutcome {
  const file = join(root, "src/hooks/cosmetic-output.ts");
  const source = readText(file);
  const match = source.match(/import \{([^}]*)\} from "@earendil-works\/pi-tui";/);
  const names = (match?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (match === null || !names.includes("stripTerminalSequences")) {
    // No longer imported from pi-tui. Tell "upstream dropped the usage"
    // (retire) apart from "upstream reshaped the import" (must not guess).
    if (source.includes("stripTerminalSequences(")) {
      fail(
        `P2: ${rel(file)} still calls stripTerminalSequences but no longer imports it from ` +
          "@earendil-works/pi-tui — import reshaped, update the patch",
      );
    }
    step("retired P1+P2: upstream no longer uses stripTerminalSequences");
    return "retired";
  }

  const kept = names.filter((name) => name !== "stripTerminalSequences");
  if (kept.length === 0) fail("P2: pi-tui import would be empty — inspect upstream");

  const vendorSource = join(VENDOR_FILES, "strip-terminal-sequences.ts");
  if (!existsSync(vendorSource)) fail(`vendor file missing: ${rel(vendorSource)}`);
  mkdirSync(join(root, "src/compat"), { recursive: true });
  cpSync(vendorSource, join(root, "src/compat/strip-terminal-sequences.ts"));

  const replacement =
    `import { ${kept.join(", ")} } from "@earendil-works/pi-tui";\n` +
    `import { stripTerminalSequences } from "../compat/strip-terminal-sequences.js";`;
  writeText(file, source.replace(match[0], replacement));
  step("patched P1+P2 vendored stripTerminalSequences + import");
  return "applied";
}

/**
 * P3 — keep the receiver on `pi.on`.
 *
 * Upstream copies the method to widen its TypeScript signature and calls it
 * detached. pi's ExtensionAPI is closure-based so that works; omp's is a class
 * whose methods read `this.extension`, so the detached call throws
 * `undefined is not an object (evaluating 'this.extension')`. `bind` is a no-op
 * on pi. Self-retiring once k0valik/pi-blackhole#124 merges.
 */
export function patchReceiverBind(root: string): PatchOutcome {
  const file = join(root, "src/hooks/compact-failed.ts");
  if (readText(file).includes("pi.on.bind(pi)")) {
    step("retired P3: upstream already binds the receiver");
    return "retired";
  }
  replaceOnce(
    file,
    "const onAny = pi.on as unknown as (",
    "// Bind the receiver: hosts that implement ExtensionAPI as a class (omp's\n" +
      "  // ConcreteExtensionAPI reads `this.extension`) throw on a detached call.\n" +
      "  // No-op on pi, whose API object is closure-based.\n" +
      "  const onAny = pi.on.bind(pi) as unknown as (",
    "P3 compact-failed receiver bind",
  );
  return "applied";
}

/** P4 — manifest: git-installable, dual-host, source-only. */
function patchManifest(root: string, version: string): void {
  const file = join(root, "package.json");
  const manifest = JSON.parse(readText(file)) as Record<string, unknown>;

  manifest.version = `${version}-omp.1`;
  manifest.description =
    "Unified compaction + observational memory extension for Pi and omp — compresses conversation context while preserving durable observations and reflections";
  manifest.repository = {
    type: "git",
    url: "git+https://github.com/RockinPaul/pi-blackhole-omp.git",
  };

  // Source-only install: the published bundle is built from unpatched source, so
  // resolving `main` would load broken code. Drop the bundle and its build.
  delete manifest.main;
  delete manifest.packageManager;

  const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
  // `prepare` runs on git install and upstream's scripts/ dir is not in the tarball.
  delete scripts.prepare;
  delete scripts.build;
  scripts["test:omp"] = "bun test tests-omp/";
  manifest.scripts = scripts;

  const devDependencies = (manifest.devDependencies ?? {}) as Record<string, unknown>;
  delete devDependencies.tsup;
  manifest.devDependencies = devDependencies;

  const keywords = (manifest.keywords ?? []) as string[];
  manifest.keywords = [...new Set([...keywords, "omp", "oh-my-pi"])].sort();

  const files = (manifest.files ?? []) as string[];
  manifest.files = [
    ...files.filter((entry) => entry !== "dist/"),
    "tests-omp/**/*.ts",
    "README.upstream.md",
  ];

  // omp reads `omp.extensions` first and falls back to `pi.extensions`; declaring
  // both keeps the fork loadable on either host.
  const piManifest = (manifest.pi ?? {}) as Record<string, unknown>;
  const extensions = (piManifest.extensions ?? ["./index.ts"]) as string[];
  manifest.pi = { ...piManifest, extensions };
  manifest.omp = { extensions };

  writeText(file, `${JSON.stringify(manifest, null, 2)}\n`);
  step(`patched package.json → ${version}-omp.1`);
}

/** P5 — drop build artifacts, preserve upstream's readme under our own. */
function patchLayout(root: string): void {
  for (const dead of ["dist", "tsup.config.ts"]) {
    const path = join(root, dead);
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      step(`removed ${dead}`);
    }
  }
  const readme = join(root, "README.md");
  if (existsSync(readme)) {
    writeFileSync(join(root, "README.upstream.md"), readFileSync(readme));
    rmSync(readme);
    step("preserved upstream README as README.upstream.md");
  }
}

// ── staging → repo ──────────────────────────────────────────────────────────

function listFiles(dir: string, prefix = "", skipTopLevel: string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = prefix === "" ? entry : `${prefix}/${entry}`;
    if (prefix === "" && skipTopLevel.includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, path, skipTopLevel));
    else out.push(path);
  }
  return out;
}

function publishTree(staging: string): void {
  const incoming = listFiles(staging);
  const incomingPaths = new Set(incoming);

  // Prune repo-root files upstream no longer ships. Repo-owned paths are never
  // enumerated, so `.git` and friends are neither walked nor touched.
  for (const path of listFiles(REPO_ROOT, "", PRESERVE)) {
    if (incomingPaths.has(path)) continue;
    rmSync(join(REPO_ROOT, path));
    step(`pruned ${path}`);
  }

  for (const path of incoming) {
    const target = join(REPO_ROOT, path);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(staging, path), target);
  }
  step(`published ${incoming.length} files from upstream + patches`);
}

// ── verification ────────────────────────────────────────────────────────────

function runBunTests(): void {
  const proc = Bun.spawnSync(["bun", "test", "tests-omp/", "patches/"], {
    cwd: REPO_ROOT,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (proc.exitCode !== 0) fail("tests failed");
  step("tests pass (tests-omp + patches)");
}

/**
 * Token-free load check: `omp --mode rpc` loads extensions and prints their UI
 * registrations without making a model call. Requires this fork to be the
 * installed/linked `pi-blackhole` plugin.
 */
async function verifyLoadInOmp(): Promise<void> {
  const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-session"], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
  });

  // Read both pipes to EOF and race a watchdog. Polling with Bun.sleepSync
  // would block the event loop and starve these readers, so the output would
  // always look empty.
  const drained = (async () => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return `${out}${err}`;
  })();
  const watchdog = (async () => {
    await Bun.sleep(15_000);
    proc.kill();
    return "";
  })();

  const output = await Promise.race([drained, watchdog]);
  proc.kill();

  if (output.includes("Failed to load extension")) {
    const line = output.split("\n").find((entry) => entry.includes("Failed to load extension"));
    fail(`omp load check failed:\n  ${line ?? output.slice(0, 400)}`);
  }
  if (!output.includes('"statusKey":"blackhole"')) {
    fail(
      "omp load check inconclusive: no blackhole status line within 15s.\n" +
        "  Is this fork the installed plugin?  omp plugin link " +
        REPO_ROOT +
        "\n" +
        (output === "" ? "  (watchdog fired with no output — is `omp` on PATH?)" : `  saw: ${output.slice(0, 300)}`),
    );
  }
  step("omp load check pass (status bar rendered, no load error)");
}

function assertCleanTree(force: boolean): void {
  if (force) return;
  const proc = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO_ROOT, stderr: "pipe" });
  const dirty = proc.stdout.toString().trim();
  if (dirty.length > 0) {
    fail(
      "repo has uncommitted changes; commit or stash them first (or pass --force):\n" +
        dirty.split("\n").slice(0, 10).join("\n"),
    );
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(options: Options): Promise<void> {
  assertCleanTree(options.force);

  const version = await resolveVersion(options.version);
  step(`upstream ${PKG}@${version}`);

  const tmpRoot = join(import.meta.dir, ".tmp");
  const workDir = join(tmpRoot, `${version}-${Date.now()}`);
  const staging = join(workDir, "package");
  mkdirSync(staging, { recursive: true });

  try {
    const tarball = await downloadTarball(version, workDir);
    extract(tarball, staging);

    const outcomes: Record<string, PatchOutcome> = {
      "P1+P2 stripTerminalSequences": patchTerminalSequences(staging),
      "P3 receiver bind": patchReceiverBind(staging),
    };
    patchManifest(staging, version);
    patchLayout(staging);

    const names = Object.keys(outcomes);
    const retired = names.filter((name) => outcomes[name] === "retired");
    if (retired.length === names.length) {
      console.log(
        `\n⚠ no compat patch was needed for ${PKG}@${version} — this fork is a passthrough.\n` +
          `  Stock \`omp plugin install npm:${PKG}\` should work on an omp release that\n` +
          "  carries the host fix; consider archiving this repo.\n",
      );
    } else if (retired.length > 0) {
      console.log(`⚠ retired (fixed upstream): ${retired.join(", ")}`);
    }

    publishTree(staging);
    runBunTests();
    if (options.verifyLoad) await verifyLoadInOmp();

    console.log(`\n✔ ${PKG}@${version}-omp.1 ready in ${REPO_ROOT}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    // Drop the staging root only when empty, so a concurrent run is untouched.
    if (readdirSync(tmpRoot).length === 0) rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const detail =
      error instanceof PatchError
        ? error.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error);
    console.error(`\n✖ ${detail}\n`);
    process.exit(1);
  }
}