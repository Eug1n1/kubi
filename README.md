# Kubi

A desktop client for Kubernetes. Browse a cluster, read what an object is made
of, follow its logs, open a shell in a container and forward a port — without
leaving the keyboard.

Kubi is a Tauri app: a Rust core talks to the Kubernetes API and a React front
end renders what it sends back.

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

**Inspect**

- A detail panel with facts, labels and annotations, and tabs for the object's
  manifest, its data, its sources, its events and its metrics.
- Containers: image, ports, live state with the waiting reason or exit code,
  restarts, requests and limits, environment grouped by where each value comes
  from, and the volumes each container mounts.
- Sources: the ConfigMaps and Secrets a pod refers to, with their keys resolved
  and secret values revealed one at a time.
- The manifest opens in an editor with line numbers, YAML colouring and a find
  bar (`Ctrl`/`Cmd` + `F`) that takes regular expressions and can replace, and
  the edited document can be patched straight back into the cluster.
- Metrics for pods and nodes, with CPU and memory history.

**Act**

- Logs per pod and container, following, with the previous container, timestamps
  and a regex filter, in the drawer or in a window of its own.
- A shell in any container, and port forwarding for a pod or a service port.

**Make it yours**

- Settings with rebindable shortcuts and a theme derived from one base colour,
  with light and dark modes; contrast for accents and filled buttons is computed
  rather than eyeballed.

## Requirements

- macOS for the packaged app (the bundle targets are `app` and `dmg`).
- Rust 1.95.0, pinned in `rust-toolchain.toml`.
- Node 20 or newer (CI uses 22) and the Tauri prerequisites for macOS (Xcode
  Command Line Tools).
- A kubeconfig: the standard `~/.kube/config` or `$KUBECONFIG` is picked up
  automatically, and another file can be chosen in the app.

## Build and run

```sh
make install   # npm install
make dev       # Vite dev server plus Tauri, with hot reload
make test      # tsc and a production build, then cargo test --workspace
make dmg       # .app and .dmg into target/release/bundle/
make preview   # render the visual harness pages (see below)
```

`make` on its own lists every target. `make dmg` asks the bundler for `app,dmg`
together, because a dmg-only run cleans up an `.app` it never wrote and fails
after a valid dmg was produced, and it sets `CI=true` so create-dmg skips its
Finder AppleScript — that step fails on macOS 15+/26 and needs Automation
permission for the terminal. Only the icon layout of the dmg window is lost;
`make dmg-styled` builds the styled variant for anyone who has granted it.

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

## Where state lives

UI state is written next to the kubeconfig's neighbours in the app config
directory, so it survives both dev runs and bundled builds:

```
~/Library/Application Support/dev.kubi.desktop/settings.json
~/Library/Application Support/dev.kubi.desktop/context-groups.json
```

The identifier in `tauri.conf.json` decides that path; changing it moves the
files.

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
push and pull request. `.github/workflows/release.yml` builds the `.app` and the
`.dmg` on a tag and opens a draft release with them:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Run it from the Actions tab without a tag to only check that the bundle builds
and to keep the dmg as a workflow artifact.

[`CHANGELOG.md`](CHANGELOG.md) holds what shipped; move the `Unreleased` entries
under the version when tagging.

## Notes

- Secret values arrive with a `masked` flag and stay hidden behind dots until the
  eye next to one is clicked, so a single value can be revealed without another
  round trip. Masking is a UI concern, not a boundary.
- The Containers and Sources tabs resolve the objects a **pod** refers to; other
  workloads show their spec in the manifest tab.
- YAML colouring is line based rather than a full YAML parser, so flow
  collections and block scalars are coloured as plain values.
- Only macOS bundles are configured today.

