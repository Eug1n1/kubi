# Changelog

All notable changes to Kubi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `Unreleased` section holds what is on `main` but not in a release yet; on a
`v*` tag the release workflow builds the installers for macOS, Windows and Linux
and publishes them as one release, and the section moves under the version it
shipped as.

## [Unreleased]

### Added

- Browse a cluster: Cluster (nodes, namespaces, events), Workloads (pods,
  deployments, replica sets, stateful sets, daemon sets, jobs, cron jobs),
  Network (services, endpoints, endpoint slices, ingresses, ingress classes,
  network policies), Config (config maps, secrets, resource quotas, limit
  ranges, horizontal pod autoscalers, pod disruption budgets), Storage
  (persistent volume claims and volumes, storage classes), Access (service
  accounts, roles and role bindings, cluster roles and cluster role bindings)
  and the Gateway API (classes, gateways, listener sets, HTTP, gRPC, TLS, TCP
  and UDP routes, backend TLS policies, reference grants), plus any custom
  resource the cluster serves and Argo CD views when its CRDs are installed.
  Lists update from watches, sort and filter locally.
- A detail panel per object: facts, labels and annotations, and tabs for the
  manifest, the data, the sources, the events and the metrics.
- Containers of a pod: image, ports, live state with the waiting reason or exit
  code, restarts, requests and limits, environment grouped by where each value
  comes from, and the volumes each container mounts.
- Sources of a pod: the ConfigMaps and Secrets it refers to, with their keys
  resolved and every secret value revealed on demand.
- A YAML editor for the manifest with line numbers, colouring, a find bar that
  takes regular expressions, replace and Tab indentation, and patching the
  edited document back into the cluster.
- Logs per pod and container: follow, the previous container, timestamps and a
  regex filter, in the drawer or in a window of its own.
- A shell in any container, and port forwarding for a pod or a service port.
- Spotlight search over resources and namespaces, with Tab completion for the
  entry and the namespace and `Ctrl+N`/`Ctrl+P` (or the arrows) to move.
- Warning events surfaced three ways: a marker in the object list, a card on the
  object overview and an Events tab.
- A context rail with folders, drag-to-reorder and collapsing, stored next to
  the app's settings.
- Settings with rebindable shortcuts and a theme derived from one base colour:
  light and dark modes, accent and status colours, computed contrast, and a
  terminal palette that follows.
- A visual harness (`make preview`) that renders the real components with fake
  data into pages any headless browser can screenshot.
- Windows and Linux support: the shell has no platform-specific code, the
  bundler produces `.msi`/`.exe` on Windows and `.deb`/AppImage on Linux next to
  the macOS `.dmg`, and CI builds and tests on all three.

### Changed

- Panels resize: the detail panel stops short of the object list and is clamped
  back when the window shrinks, its tab strip scrolls sideways, each table in it
  scrolls on its own, and value cells keep room for 120 characters per line.
- The manifest tab fills the panel instead of stopping at a fixed height, and
  its actions are icon buttons rather than bare text.
- The bundle identifier is `dev.kubi.desktop` instead of `dev.kubi.app`, which
  conflicted with the macOS bundle extension.
- Vendor code is split into react, xterm and tauri chunks instead of one 700 kB
  file.

### Removed

- The earlier egui prototype (`crates/kubi-ui`, `apps/kubi`); the workspace now
  holds the core and the Tauri shell only.

### Fixed

- A pod that came up again no longer keeps warning markers that were only about
  probe failures.
- The namespace hint stays visible once a spotlight fragment resolves to a
  single namespace.
- An unfinished regex in the list filter falls back to plain text instead of
  blanking the table.
- A long secret or annotation wraps at a readable width instead of being
  squeezed into a narrow column.
