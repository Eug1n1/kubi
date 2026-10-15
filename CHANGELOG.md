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

- A cluster in a window of its own: `Open separately` in a context's
  right-click menu opens a window pinned to that one cluster, which keeps
  working while the main window browses others and keeps its connection when
  the window closes. The rail marks the contexts that have their own window,
  clicking the mark focuses it, and opening a context again focuses its window
  instead of a second one. Logs, shells and port forwards opened in a context
  window belong to it, a window whose context left the kubeconfig says so
  instead of going away, and theme and color changes now apply to every window
  of the app at once.
- Named color themes: Settings → Colors lists the themes the app ships with — the
  current dark look and its light counterpart with the same accent and status
  colors — and switches between them in one click. Choosing a theme applies all
  of it, base color, mode, accent and status colors together, which the old
  preset row did not do. The colors on screen can be named and kept as a custom
  theme — saving under an existing custom name updates it, and custom themes can
  be deleted again. The choice is remembered across restarts; custom themes live
  in `themes.json` in the app config directory.
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
- A YAML editor for the manifest with line numbers, coloring, a find bar that
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
- Settings with rebindable shortcuts and a theme derived from one base color:
  light and dark modes, accent and status colors, computed contrast, and a
  terminal palette that follows.
- A visual harness (`make preview`) that renders the real components with fake
  data into pages any headless browser can screenshot.
- Windows and Linux support: the shell has no platform-specific code, the
  bundler produces `.msi`/`.exe` on Windows and `.deb`/AppImage on Linux next to
  the macOS `.dmg`, and CI builds and tests on all three.
- Several clusters at once: tabs are bound to a cluster, so one window can hold
  tabs of different clusters and keep their watches, log streams, port forwards
  and shells running while you move between them. Every command names the
  context it works on, a tab is marked with its cluster's color and name, and
  the rail shows which contexts have tabs open.
- A right-click menu on a context: disconnect the cluster (its tabs close and
  its streams stop, every other cluster keeps running) and pick the color that
  marks it, from a palette or back to the hue of its name. Picked colors are
  remembered in the app's settings.

### Changed

- The Settings button in the topbar is a cog instead of a sun: the old glyph was
  a ring with eight rays, which reads as brightness rather than settings.
- The small things that make the window feel finished: menus and modals rise
  into place instead of appearing, buttons that start something give slightly
  under the pointer, counts keep their width while they change, panel prose
  stops leaving a single word on its last line, and a menu's corner is drawn as
  the padding plus the corner inside it. Icon buttons keep their 26px look but
  answer to a bigger target where the neighbours allow it, and one surface uses
  one icon stroke weight.
- The sidebar opens with every resource group closed, and a group opens itself
  when the view inside it is the one on screen, whether it came from a tab, from
  spotlight or from another window. Group titles are brighter and bolder, with a
  hairline between sections, so a collapsed sidebar still reads as a list of
  what the cluster holds.
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

- The context list no longer slides shut under an open context menu: the menu
  is drawn at the cursor, outside the rail, so moving the pointer onto it used
  to collapse the very list the menu belongs to.
- Hovering or pressing a tab lights the whole tab, close spot included, instead
  of a patch over the label while the rest of the strip stayed dark. The strip
  is the only thing that paints a tab now, so its buttons stay transparent; the
  same for the tabs of the log drawer.
- A rule in the stylesheet lost its selector, which made the browser drop the
  namespace dropdown and every menu drawn after it. Context menus and the row
  menu now have the panel, hover and danger styles they were written for.
- A pod that came up again no longer keeps warning markers that were only about
  probe failures.
- The namespace hint stays visible once a spotlight fragment resolves to a
  single namespace.
- An unfinished regex in the list filter falls back to plain text instead of
  blanking the table.
- A long secret or annotation wraps at a readable width instead of being
  squeezed into a narrow column.
