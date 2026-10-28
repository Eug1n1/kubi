# Working on Kubi: notes for agents

This file is for whoever picks the code up next — an AI agent or a person in a
hurry. [`README.md`](README.md) explains what the app does and how to build it;
this one is about how the code is put together, what is easy to break, and how
to check a change before saying it works.

## What it is

A Tauri 2 app. `crates/kubi-core` is the engine: it takes `Command`s over a
channel and answers with `AppEvent`s, and it is the only thing that talks to the
Kubernetes API. `apps/desktop/src` is the React UI, which renders those events.
The window never blocks on the API server, and a watch keeps a list current on
its own.

## Commands

| Command | What it does |
| --- | --- |
| `make verify` | **The gate.** `cargo fmt --all --check`, clippy with warnings as errors, `npm run build`, `npm test`, `cargo test --workspace` |
| `make test` | The same minus format and lint: `npm run build` (which is `tsc --noEmit && vite build`), `npm test` (vitest), `cargo test --workspace` |
| `make doctor` | Checks this machine can build, test and screenshot: Rust, rustfmt, clippy, Node 20+, `node_modules`, a browser |
| `make fmt` / `make lint` | `cargo fmt --all` / clippy over every target |
| `make install` | `npm install` in `apps/desktop` |
| `make dev` | Vite + Tauri with hot reload |
| `make preview` | Renders `apps/desktop/preview/page-*.html` from the visual harness |
| `make shots` | Screenshots every harness page into `preview/shots-<timestamp>/` (`CHROME`, `SHOT_SIZE`, `SHOT_OUT` override) |
| `make contrast` | Checks every text/surface pair the stylesheet relies on; non-zero exit on a failing pair |
| `make dmg` | macOS `.dmg` + `.app` (`dmg-styled` keeps the Finder icon layout) |
| `make bundle` | The installers for the current platform, from `tauri.conf.json` |
| `make clean` / `distclean` | Drop build artifacts / also `node_modules` |

Rust is pinned in `rust-toolchain.toml` (1.95.0) and the core is
`#![forbid(unsafe_code)]`. Node 20+ (CI uses 22, and `.nvmrc` says 22). A warm
`make verify` takes about fifteen seconds; the first Rust build takes minutes.

## Where things live

```
crates/kubi-core/src/
  engine.rs      5.2k lines: the event loop, every command handler, the watches,
                 logs, port forwards, execs, Argo, YAML and pod detail fetches
  model.rs       the wire protocol: Command, AppEvent, ResourceKind, WatchTarget
  rows.rs        turning Kubernetes objects into table rows
  kubeconfig.rs  reading contexts out of a kubeconfig
  quantity.rs    CPU/memory/age formatting on the Rust side
  yaml.rs        manifest masking and cleanup
  metrics_types.rs  types for the metrics API
apps/desktop/src-tauri/src/main.rs
                 the Tauri shell: `send_command`, config files, the event bridge
apps/desktop/src/
  useKubi.ts     2k lines: all UI state and every action; the one hook the app uses
  screens.tsx    2.7k lines: topbar, sidebar, tables, detail panel, modals, drawers
  contexts.tsx   the context rail: folders, drag, the right-click menu
  types.ts       the protocol as TypeScript, plus the shared view helpers
  catalog.ts     the nav tree, view titles, what each kind can do (logs/exec/…)
  columns.ts     the table columns per kind
  format.ts      number and age formatting, and `clusterColor`
  api.ts         the five `invoke` calls: send_command and the two config files
  windows.ts     window labels as addresses: who a dock window answers to,
                 what a ctx-* window is pinned to
  theme.ts       one base color -> every CSS token
  prefs.ts       what `settings.json` holds (keymap, theme, context colors)
  keymap.ts      rebindable shortcuts and their defaults
  settings.tsx   the settings modal
  styles.css     the whole stylesheet
  App.tsx        the composition root; main.tsx picks the window to render
  yamlEditor.tsx the manifest editor; logWindow.tsx / execWindow.tsx are the
                 detached windows
  templates.ts   the YAML a new object starts from
  *.test.ts      vitest over the pure modules (format, keymap, prefs, theme,
                 windows); anything that renders is checked through the harness
apps/desktop/preview/
  gallery.tsx    the visual harness; contrast.ts checks the palette
  shots.mjs      screenshots every rendered page, headless
crates/kubi-core/tests/protocol_mirror.rs
                 reads model.rs and types.ts and fails when the two disagree
scripts/doctor.sh  whether this machine can build, test and screenshot
.github/       CI, the release workflow, the opt-in agent run, issue and PR
               templates, dependabot
docs/agents/
  issue-tracker.md, triage-labels.md, domain.md, workflow.md
                 what the engineering skills read: where issues live, the triage
                 label vocabulary, how to use the glossary and ADRs, and the loop
                 from issue to pull request
```

## How a change flows

1. The UI calls an action from `useKubi` (or a component calls `send({...})`
   directly through `api.ts`).
2. `send_command` hands the `Command` to the engine; the engine does the work on
   the Kubernetes API.
3. The engine emits an `AppEvent`; the shell forwards it on the `kubi` channel;
   `useKubi` listens (`listen<AppEvent>("kubi", …)`) and updates state.

Adding a command or an event touches four places: `model.rs` (plus a line in its
`serde_tests`), the dispatch match in `engine.rs`, `types.ts`, and the handler in
`useKubi`. Nothing generates one side from the other — the protocol is mirrored
by hand — so `crates/kubi-core/tests/protocol_mirror.rs` reads both files and
fails with the tag that drifted. It covers `Command`, `AppEvent`, `ResourceKind`,
`StatusTone` and `WatchTarget`; a new enum in the protocol belongs in that test.

Detached log and exec windows talk over their own channels (`log-ready`,
`log-dock`, `log-close`, `log-pod`, …) with `emitTo`, addressed to the window
that opened them — `log-3:ctx-prod` answers to that context window, a plain
`log-3` to the main one. Each window decides what to render from its window
label (`main`, `ctx-*`, `log-*`, `exec-*`); a `ctx-*` label is a context
window, a main-like window pinned to one context whose exact name rides in
its URL query.

## Invariants worth not breaking

**A cluster is named, never assumed.** Every command and every event that
touches a cluster carries `context`. Engine state is per context: `clients`,
`namespaces`, `watches`, `catalogs` and the Argo cache are all keyed by it. A
tab is matched to incoming rows by **(context, target)** — two `pods` watches
from two clusters would otherwise land in one list. Commands that change the
cluster (`delete`, `restart`, `apply`, `startLogs`, `startPortForward`,
`startExec`) must name the context too: guessing "the current one" is how you
delete a resource in the wrong cluster.

**Connecting is additive.** `Command::Connect` must not stop other clusters'
watches, logs, forwards or execs — that is the whole point of the feature. Live
streams are keyed by id *and* remember their context (`LiveStream`, `ExecSlot`)
so `Disconnect` stops only its own. When you add a stream, record the context
with it, or the teardown will be wrong.

**A context window is a main-like window pinned to one context.** It renders
the same `App` with a `pinned` prop, filters broadcast events to its own
cluster (`eventScope` in `types.ts`), and opens its own dock windows, which
answer to it by label. Stream ids are drawn from a per-window random base
(`streamIdBase` in `useKubi.ts`) because the engine keys streams by id alone —
two windows counting from 1 would collide. Opening a context window connects
its cluster; a repeat connect is safe (the engine restarts the catalog), and
closing the window leaves the cluster connected.

**Each `AppEvent` is a one-key object.** `eventKey()` reads
`Object.keys(event)[0]`, and the enum is serde `camelCase` with
`rename_all_fields`, so `{ "rows": { … } }` arrives as `event.rows`.

**The UI has one source of state.** `useKubi()` owns everything and returns it as
`Kubi` (`ReturnType<typeof useKubi>`); components take `{ kubi }` and never fetch
or keep cluster state of their own. `session.current` is the mutable mirror of
that state which event handlers read — the React state is for rendering, the ref
is for logic. Anything per context is a map keyed by context in there
(`namespaces`, `customResources`, `overview`, `defaults`), and usage samples are
keyed `context|namespace/name`.

**Context colors are one map, two readers.** `clusterColor(name)` prefers a
color picked by hand (a module-level map filled by `setClusterColors`) and falls
back to a hue hashed from the name. The window mirrors the same map in state so
a change re-renders; call `setClusterColors` before `setState` so the plain
helpers and the render agree. Colors persist in `settings.json` through
`prefs.ts` (currently version 4; unknown or malformed entries are dropped on
read).

**Settings are files in the app config dir**, not `localStorage`:
`settings.json` and `context-groups.json` under `dev.kubi.desktop` (see the
README for the exact paths). Both are written through a temporary file.

## Styling

One stylesheet, one source of color. `theme.ts` derives every CSS custom
property from a single base color and `applyTheme` writes them onto the root at
runtime, so a rule should use a token (`var(--fg)`, `var(--hover)`,
`var(--bg-panel)`, `--sp1..--sp5`, `--r-sm|md|lg`, `--t`, `--t-fast`) and never
a hex of its own. `preview/contrast.ts` lists every text/surface pair the
stylesheet relies on with the ratio it needs:

```sh
make contrast
```

It prints PASS/FAIL per theme preset and exits non-zero when a pair fails, so it
is a gate rather than something to read.

Three traps that have cost real time here:

- **A lost selector kills every rule after it.** A rule whose `{` or `}` went
  missing, or whose selector line disappeared, makes the browser drop that rule
  and everything nested inside it, silently — the UI just loses styling. After
  editing the stylesheet, check the braces:

  ```sh
  # from the repository root
  python3 - <<'EOF'
  depth = 0
  for n, line in enumerate(open('apps/desktop/src/styles.css'), 1):
      depth += line.count('{') - line.count('}')
      if depth < 0:
          print('extra } at line', n)
          break
  print('final depth', depth)   # must be 0
  EOF
  ```

- **Space that looks like part of a row has to belong to that row.** A gap made
  with `margin-top` on the *next* element is not painted by the previous row's
  `:hover`, so a highlighted row looks cut off at the bottom. Put the gap in the
  row's own padding. (This is how the sidebar sections are built now.)
- **A composite widget paints as one object.** The global `button:hover` and
  `button:active` rules light up whatever button the pointer is over, which
  inside a tab or a menu item reads as a patch of a different object. Keep the
  inner buttons `background: transparent` and let the widget paint; the rules
  for that sit below the globals on purpose, and they win by order at equal
  specificity.

## Checking a change

`make verify` is the floor, and it is one command: `cargo fmt --all --check`,
clippy with warnings as errors, the front end build (which is `tsc --noEmit &&
vite build`), the JS tests and the Rust tests. Warm it takes about fifteen
seconds; `make doctor` says whether this machine can run it at all.

The Rust tests cover the pure logic (row building, quantity formatting, YAML
masking, warning aggregation, kubeconfig parsing) and the engine's bookkeeping
(per-context namespaces, watches, stream teardown); `protocol_mirror.rs` covers
the Rust and TypeScript sides agreeing. The JS tests (`vitest`, `*.test.ts` next
to the module) cover the pure modules only — `format.ts`, `keymap.ts`,
`prefs.ts`, `theme.ts`, `windows.ts` — because that environment has no DOM and no
Tauri. Anything that renders is checked by looking at it:

```sh
make shots     # every harness page, 1200x900, into preview/shots-<timestamp>/
```

`make shots` is `make preview` plus a headless Chrome run over each page;
`CHROME`, `SHOT_SIZE` and `SHOT_OUT` override the browser, the viewport and the
output directory.

Two things the harness cannot do as it stands, and what to do instead:

- **`:hover` and `:active` never fire** in a static render, so a hover fix cannot
  be screenshotted as it is. Put the declarations the state would produce on a
  throwaway class (`.tab.probe { background: var(--hover) }`), add that class to
  the element from a `<script>` in a copy of the page, then measure
  `getComputedStyle` as well as look at it. `--force-device-scale-factor=3` makes
  a few pixels of misfit visible.
- **Portals do not render through SSR**: React refuses with "Portals are not
  currently supported by the server renderer" and the harness dies. Components
  that portal (the context menu, the tab drag ghost) therefore cannot appear in
  a `page-*.html` as they are. To check one, mount it in a browser: bundle a
  small entry that renders the component with `createRoot`, inline that bundle
  into a page carrying the app stylesheet, and drive it with real events
  (`row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))`) while
  writing measurements into the DOM for `--dump-dom` to read. That is how "the
  context list stays out while its menu is open" was verified.

When you measure animated geometry, turn transitions off inside the probe
(`* { transition: none !important }`): under `--virtual-time-budget` they race
the timers and the numbers come out either way.

A new harness page is a few lines in the `pages` list at the bottom of
`gallery.tsx`; the generated pages are gitignored.

## Traps in the toolchain

- **`macro_rules!` bodies cannot see locals from the call site.** The watch
  macros in `engine.rs` take the context as an argument for exactly this reason:
  a local `context` in the calling function is invisible inside the macro.
- **The engine is one file and one `impl`.** Big on purpose: the commands are a
  flat `match` near the top and everything else is grouped by feature below it.
  Follow that order rather than inventing a module for one function. Three
  functions carry `#[allow(clippy::too_many_arguments)]` — `start_forward`,
  `start_logs`, `load_detail` — because the dispatch match hands a command's
  fields over flat; grouping them into a request struct would move the same
  fields one level down. The allow is a decision, not an oversight.
- **serde's `camelCase` only lowercases the first letter.** `rename_all =
  "camelCase"` is not a word splitter: `BackendTLSPolicies` travels as
  `backendTLSPolicies`, which is what `types.ts` has to spell.
  `protocol_mirror.rs` fails on the difference, and its `serde_camel_case` test
  pins the rule.
- **The Tauri config is per platform.** Installer types come from
  `tauri.conf.json` and its `tauri.windows.conf.json` / `tauri.linux.conf.json`
  companions, so a new one goes into the right companion, not into a workflow
  flag.
- **`make dmg` sets `CI=true`** so the bundler skips `create-dmg`'s Finder
  AppleScript step, which fails on recent macOS without Finder Automation
  permission; only the dmg window's icon layout is lost. `make dmg-styled` is
  the pretty one.
- **`macos-latest` is arm64**, so a tag publishes an `aarch64.dmg` only: there is
  no Intel or universal build yet.
- **CI builds bundles only on a tag**; pushes and pull requests check the Rust
  formatting everywhere, build and test the front end and the Rust workspace on
  macOS, Linux and Windows, and run clippy once, on Linux.
- **The bundle identifier and the config directory are linked**: changing the
  identifier in `tauri.conf.json` moves `settings.json` and
  `context-groups.json`.
- **The `kubi` event channel is the only bridge.** Nothing polls, so if the UI
  stops updating either the event is not emitted or `useKubi`'s
  `handleRef.current` does not handle it.

## Conventions

- **Comments say why.** The code explains itself; a comment earns its place by
  recording a decision, a trap or a trade-off ("a hover covers the whole row, so
  the gap belongs to the row"), usually in one line. No banners, no restating
  what the next line does.
- **American spelling**: color, behavior, center. The repository used British
  spelling until recently — do not reintroduce it.
- **Commit messages**: `type(scope): imperative summary` — `feat(desktop):`,
  `fix(release):`, `chore:` — followed by a body that says why the change is
  needed and how it was checked.
- **Every user-visible change gets a `CHANGELOG.md` line** under `Added`,
  `Changed` or `Fixed` in `Unreleased`, phrased for a user rather than for a
  developer. A pure refactor does not need one.
- **The README is the user's manual and the harness is the visual contract**:
  when behaviour or a screen changes, update them in the same commit.
- **Tests live next to the code** — a `#[cfg(test)] mod *_tests` at the bottom of
  the Rust file they cover, a `*.test.ts` beside the TypeScript module — and they
  test pure functions or engine bookkeeping, never a live cluster. A new rule in
  the protocol gets a line in `model::serde_tests`, and a new enum in it gets a
  line in `tests/protocol_mirror.rs`.

## Open threads

- **Multi-cluster stage 3.** Stages 1 and 2 are in (tabs bound to a cluster,
  per-context state, disconnect, context colors). Left: lists that aggregate
  several clusters, and a split view.
- **The `v0.1.0` release is a draft on GitHub.** It was created before the
  workflow was fixed to publish rather than draft, so either publish it or
  re-push the tag.
- **The release matrix has no Intel macOS build** (`macos-13`, or a universal
  dmg) and no bundle builds on pull requests.
- **Multi-cluster has never been exercised against two real clusters.** Engine
  tests and the harness cover it; a two-context kubeconfig is the check still
  missing.
- **The dock panes (logs, exec) are shared across clusters on purpose** — they
  keep running when the window moves to another cluster — and the error banner is
  not yet tagged with the cluster it came from.

## Agent skills

### Work loop

How an issue becomes a pull request: the order to do things in, the command for
each step, what "done" means, and when to stop and ask instead of guessing. See
`docs/agents/workflow.md`.

### Issue tracker

Issues and specs live as GitHub issues in `Eug1n1/kubi`, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repository root. See `docs/agents/domain.md`.

<!-- entire-agent:begin -->
Read .entire/agent-guide.md for this repository's workflow, source inspection, and verification guidance.
@.entire/agent-guide.md
<!-- entire-agent:end -->
