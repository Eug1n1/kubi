# Kubi

A desktop client for Kubernetes. Browse a cluster, read what an object is made
of, follow its logs, open a shell in a container and forward a port — without
leaving the keyboard.

Kubi is a Tauri app: a Rust core talks to the Kubernetes API and a React front
end renders what it sends back. It runs on macOS, Windows and Linux.

## Features

**Browse**

- Cluster, workloads, network, config, storage, access and Gateway API views,
  plus any custom resource the cluster serves.
- Lists update from watches, sort and filter locally, and mark objects that
  raised warning events. Warnings that only concern probes are dropped once a
  pod is settled again.
- Spotlight search over every resource and namespace (`Ctrl`/`Cmd` + `A` by
  default, rebindable) and a namespace picker with autocomplete.
- A rail of kubeconfig contexts, grouped into folders.
- Any context in a window of its own: `Open separately` in its right-click
  menu opens a window pinned to that cluster, which keeps working while the
  main window browses others and keeps its connection when the window closes.
  The rail marks the contexts that have their own window, and clicking the
  mark focuses it. Logs and shells opened in a context window belong to that
  window.

**Inspect**

- A detail panel with facts, labels and annotations, and tabs for the object's
  manifest, its data, its sources, its events and its metrics.
- Containers: image, ports, live state with the waiting reason or exit code,
  restarts, requests and limits, environment grouped by where each value comes
  from, and the volumes each container mounts.
- Sources: the ConfigMaps and Secrets a pod refers to, with their keys resolved
  and secret values revealed one at a time.
- The manifest opens in an editor with line numbers, YAML coloring and a find
  bar (`Ctrl`/`Cmd` + `F`) that takes regular expressions and can replace, and
  the edited document can be patched straight back into the cluster.
- Metrics for pods and nodes, with CPU and memory history.

**Act**

- Logs per pod and container, following, with the previous container, timestamps
  and a regex filter, in the drawer or in a window of its own.
- A shell in any container, and port forwarding for a pod or a service port.

**Make it yours**

- Settings with rebindable shortcuts and a theme derived from one base color,
  with light and dark modes plus named themes — the shipped pair and any you
  name yourself; contrast for accents and filled buttons is computed rather
  than eyeballed.

## Requirements

- macOS 11+, Windows 10+ or a Linux desktop with WebKitGTK 4.1.
- Rust 1.95.0, pinned in `rust-toolchain.toml`.
- Node 20 or newer (CI uses 22).
- Build prerequisites: the Xcode Command Line Tools on macOS; on Linux
  `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` and
  `patchelf`. Windows needs nothing beyond Rust and Node — WebView2 ships with
  the system and the bundler fetches its own WiX and NSIS.
- A kubeconfig: the standard `~/.kube/config` or `$KUBECONFIG` is picked up
  automatically, and another file can be chosen in the app.

## Build and run

```sh
make install   # npm install
make dev       # Vite dev server plus Tauri, with hot reload
make test      # tsc and a production build, then cargo test --workspace
make bundle    # installers for this platform: dmg, msi/nsis or deb/AppImage
make dmg       # macOS only: the .app and the .dmg
make preview   # render the visual harness pages (see below)
```

`make` on its own lists every target. Which installers `make bundle` produces
comes from `tauri.conf.json` and its `tauri.windows.conf.json` /
`tauri.linux.conf.json` companions — `app` and `dmg` on macOS, `msi` and `nsis`
on Windows, `deb` and AppImage on Linux — and they land in
`target/release/bundle/`.

On macOS the `dmg` target also asks for `app,dmg` together, because a dmg-only
run cleans up an `.app` it never wrote and fails after a valid dmg was produced,
and it sets `CI=true` so create-dmg skips its Finder AppleScript — that step
fails on macOS 15+/26 and needs Automation permission for the terminal. Only the
icon layout of the dmg window is lost; `make dmg-styled` builds the styled
variant for anyone who has granted it.

## Layout

```
crates/kubi-core        the engine: commands in, events out, over kube-rs
apps/desktop/src-tauri  the Tauri shell: command bridge, config files, windows
apps/desktop/src        the React UI
apps/desktop/preview    visual harness: renders the real components with fake data
```

The core owns everything that touches the cluster. The UI sends commands
(`watch`, `fetchYaml`, `fetchPodSources`, `startLogs`, …) and reacts to the
events that come back, so the window never blocks on the API server and a watch
keeps a list current on its own.

Working on the code? [`AGENTS.md`](AGENTS.md) covers the conventions, the
invariants worth not breaking and how to check a change — including the parts
the visual harness cannot show.

## Where state lives

UI state is written next to the kubeconfig's neighbours in the app config
directory, so it survives both dev runs and bundled builds:

```
macOS    ~/Library/Application Support/dev.kubi.desktop/
Windows  %APPDATA%\dev.kubi.desktop\
Linux    ~/.config/dev.kubi.desktop/
```

with `settings.json`, `context-groups.json` and `themes.json` inside. The
identifier in `tauri.conf.json` decides those paths; changing it moves the files.

## Themes

The window's colors are a named theme. Settings → Colors lists the ones the app
ships with — the dark default and its light counterpart, sharing the accent and
status colors — plus any custom theme loaded with **Load theme…**.

A theme is a JSON document: a name plus the six fields the interface is built
from. `base` and `mode` drive every surface; the accent and status colors are
used as given.

```json
{
  "name": "Solar",
  "base": "#0b1021",
  "mode": "dark",
  "accent": "#268bd2",
  "ok": "#859900",
  "warn": "#b58900",
  "bad": "#dc322f"
}
```

A ready-made example lives in [`themes/example.json`](themes/example.json). A
file may also hold an array of themes under `themes` to load a pack at once.
Unknown fields are ignored; a color that is present but not a hex value is
refused with the reason, and nothing changes.

## Visual harness

`apps/desktop/preview/gallery.tsx` renders the real components with fake data
into standalone pages, inlining the app stylesheet, so any headless browser can
screenshot them:

```sh
make preview    # writes apps/desktop/preview/page-*.html
```

The generated pages are ignored by git.

## Releasing

`.github/workflows/ci.yml` builds the front end and runs the Rust tests on every
push and pull request, on macOS, Linux and Windows. `.github/workflows/release.yml`
builds the installers for all three on a tag and publishes them as one release:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Run it from the Actions tab without a tag to only check that the bundles build
and to keep the installers as workflow artifacts.

[`CHANGELOG.md`](CHANGELOG.md) holds what shipped; move the `Unreleased` entries
under the version when tagging.

## Notes

- Secret values arrive with a `masked` flag and stay hidden behind dots until the
  eye next to one is clicked, so a single value can be revealed without another
  round trip. Masking is a UI concern, not a boundary.
- The Containers and Sources tabs resolve the objects a **pod** refers to; other
  workloads show their spec in the manifest tab.
- YAML coloring is line based rather than a full YAML parser, so flow
  collections and block scalars are colored as plain values.
- Installers are configured per platform in `tauri.conf.json` and its
  `tauri.windows.conf.json` / `tauri.linux.conf.json` companions. Windows builds
  are unsigned, so SmartScreen will warn about them; macOS builds are unsigned
  too unless the signing keys are provided.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Copyright 2026 Kubi
contributors.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project, as defined in the Apache-2.0 license, shall be
licensed as above, without any additional terms or conditions.

