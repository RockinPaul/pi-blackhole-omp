# pi-blackhole-omp

[pi-blackhole](https://github.com/k0valik/pi-blackhole) (unified compaction + observational memory) patched so it installs on [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi) — while still loading unmodified on upstream pi. Stock `pi-blackhole@0.5.7` cannot be installed on omp at all; both root causes are fixed here with two minimal, host-neutral patches, and both fixes are being submitted upstream so this fork can eventually disappear.

## Install

```sh
omp plugin install github:RockinPaul/pi-blackhole-omp
```

The fork keeps the package name `pi-blackhole`, so it **registers under the name `pi-blackhole`**. Do not install it alongside the stock npm plugin — two copies mean duplicate commands, hooks and tools (a second `recall` tool, an ambiguous `/blackhole`). If stock `pi-blackhole` is already installed:

```sh
omp plugin uninstall pi-blackhole
omp plugin install github:RockinPaul/pi-blackhole-omp
```

## Uninstall

```sh
omp plugin uninstall pi-blackhole
```

## What is patched

Two changes, each fixing an independent hard failure. omp validates extensions by importing them at install time and rolls back on any error, so failure 1 blocks installation outright; failure 2 throws during load.

| # | File | Upstream failure it fixes | Why the fix is host-neutral |
|---|------|---------------------------|------------------------------|
| 1 | `src/hooks/cosmetic-output.ts` (plus new dependency-free `src/compat/strip-terminal-sequences.ts`) | `Export named 'stripTerminalSequences' not found in module 'omp-legacy-pi-bundled:@oh-my-pi/pi-tui'` — the hook imported `stripTerminalSequences` from `@earendil-works/pi-tui`; omp's loader rewrites `@earendil-works/*` onto its own bundled pi-tui, which predates that symbol (absent in omp 18.2.8 and in omp `main`). | The symbol is vendored into `src/compat/strip-terminal-sequences.ts` as a verbatim copy of `stripTerminalSequences` + its `extractAnsiCode` helper from pi-mono `packages/tui/src/utils.ts` — byte-identical behavior on every host, and the module imports nothing, so there is no host symbol to resolve. |
| 2 | `src/hooks/compact-failed.ts` | `TypeError: undefined is not an object (evaluating 'this.extension')` — the hook copied `pi.on` out of the API object (`const onAny = pi.on as ...`) and called it detached. Upstream pi's `ExtensionAPI` is closure-based so that works; omp implements it as a class whose methods read `this.extension`, so a detached call has no receiver and throws. | One-word change: call through `pi.on.bind(pi)`. On upstream pi, binding a closure-based `on` to its own object is a no-op. |

## Differences from upstream

- `dist/` removed and the `main` field dropped. The published bundle in the npm tarball is compiled from unpatched source, so resolving `main` would load broken code on omp; installs go through the manifest's `extensions: ["./index.ts"]` (source-only).
- Version is `<upstream>-omp.<N>` (currently `0.5.7-omp.1`) — the fork is never ahead of or behind upstream code, only re-patched.
- Manifest declares **both** `pi.extensions` and `omp.extensions` → `["./index.ts"]`, so the same tree loads on real pi.
- `tests-omp/` added: standalone tests for the vendored stripper (no host imports, run outside omp).
- The upstream README is preserved verbatim at [`README.upstream.md`](README.upstream.md).

## Verified on omp 18.2.8

Proven by running the patched tree on omp:

- The extension loads clean (zero load errors; see [Development](#development) for the token-free check that proves this).
- Every load-time registration in the plugin factory succeeds — all 25 call sites (20 event handlers, 4 slash commands, 1 tool) reached through the factory's 12 `register*` helpers, measured against omp's real `ExtensionAPI`.
- `/blackhole-memory` is dispatched by the host rather than falling through to the model (an unknown `/…` prompt produces `agent_start` + a user message; this one produces neither). Its output renders through `ctx.ui.notify`, so the rendered text itself is only observable in the interactive TUI.
- The observational-memory pipeline ran end to end: the observer recorded an observation, the reflector produced a reflection, and the dropper evaluated.
- The footer status bar renders — `bh O▕…▏ P▕…▏ X▕…▏` — driven by the `setStatus("blackhole", …)` UI call visible in the RPC trace.
- The auto-compaction trigger fires on `turn_end` / `agent_end`.

Not proven / not available:

- **No real compaction has fired yet** in these tests — the threshold-evaluation path is exercised, but a completed compaction on omp is still untested end to end.
- **Inline (mid-run) compaction is unavailable on omp.** The host probe returns `{"supported":false,"reason":"host AgentSession module could not be resolved"}` because omp ships as a single compiled binary — the module can't be imported to patch. Blackhole reports this once via a notification (`Blackhole inline compaction is unavailable: host AgentSession module could not be resolved`). `midRunCompaction` defaults to `"off"`, so nothing is lost unless you enable `resume`/`pause`; end-of-run compaction does not need this adapter.

## Known omp divergences

- **Config location** is the host agent dir: `~/.omp/agent/pi-blackhole/pi-blackhole-config.json` (on pi it is `~/.pi/agent/...`). The file is created with defaults on first load and is editable via `/blackhole settings`.
- **Project-scoped config does not apply on omp.** Overrides are read from `<cwd>/.pi/` (upstream location: `pi-blackhole-config.json` and the legacy `settings.json` key `pi-blackhole`); omp projects have no `.pi/` directory, so a project-scoped file there is silently ignored. Use the global file or `PI_BLACKHOLE_*` env vars (e.g. `PI_BLACKHOLE_MEMORY`, `PI_BLACKHOLE_COMPACTION`, `PI_BLACKHOLE_OBSERVE_AFTER_TOKENS`).
- **`fold.unknown_custom_type` debug events are benign.** omp writes session entries with `customType: "tool_execution_start"`; Blackhole's memory fold logs them (only when `debugLog: true`) and skips them. They are never memory sources anyway, so nothing is dropped from your memory.

## Cost

With stock defaults — `sessionFallback: true` and no worker models configured — the observer, reflector and dropper are billed to **your session model**. They fire at the default thresholds of 15k transcript tokens since the last observation (`observeAfterTokens`) and 25k since the last reflection (`reflectAfterTokens`). This is not cheap: one measured reflector call consumed ~24k input tokens on a trivial session.

Tune it in `/blackhole settings` — the `observerModel`, `reflectorModel` and `dropperModel` keys route each stage to a cheaper model (with per-stage fallback lists). Off-ramps, in order of bluntness:

- `"memory": false` — disable the observational-memory pipeline entirely (compaction keeps working).
- `"compactionEngine": "pi-default"` — stop Blackhole from compacting and leave compaction to the host.
- `"compaction": "manual"` — keep Blackhole's summaries but never trigger automatically.

## Tool-name collision: `recall`

Blackhole registers a tool named `recall`. omp has a built-in `recall` too, but it is only registered when `memory.backend` is `hindsight` or `mnemopi` (default: `off`). Check before installing:

```sh
omp config get memory.backend
```

If that prints anything other than `off`, the two `recall` tools collide — pick one backend.

## Development

**Re-sync to a new upstream release** — the whole fork is a patch pipeline over the npm tarball:

```sh
bun patches/apply.ts --version <upstreamVersion>   # e.g. 0.5.8
```

`patches/apply.ts` fetches the tarball for that version, applies every patch above with asserted preconditions (it exits non-zero and loud if upstream reshaped a patched region), writes the result over the repo root, and then runs the standalone tests.

**Test** (standalone, no omp, no tokens):

```sh
bun test tests-omp/
```

**Load check** (token-free, ~1.3 s, no model call) — proves the plugin imports cleanly on a local omp:

```sh
omp --mode rpc --no-session </dev/null
```

- Success: a first line `{"type":"ready",...}` plus `extension_ui_request` frames including `"statusKey":"blackhole"`.
- Failure: a `Failed to load extension <path>: …` line on stderr.

Note: `omp plugin doctor` is **not** a load gate — it reported “5 ok, 0 errors” while the extension was in fact failing to import. Trust the RPC check above.

**CI**: [`.github/workflows/resync.yml`](.github/workflows/resync.yml) runs the same pipeline weekly (and on demand), opening a PR when a new upstream version exists. It never merges anything.

## Credit

- All functionality is [k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole), MIT-licensed — see [`LICENSE`](LICENSE), the full upstream docs in [`README.upstream.md`](README.upstream.md), and the release history in [`CHANGELOG.md`](CHANGELOG.md).
- This fork adds only the two patches in [What is patched](#what-is-patched), the manifest/version adjustments around them, and the resync tooling.
