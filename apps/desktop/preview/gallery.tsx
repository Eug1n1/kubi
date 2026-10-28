/**
 * Visual harness: renders the real components with fake props into one page and
 * inlines the app stylesheet, so a headless browser can screenshot them.
 * Usage: node preview/build.cjs  (see preview/README in the repo history)
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenuBody, ContextRail } from "../src/contexts";
import { About, Colors, SettingsModal, type AboutStatus } from "../src/settings";
import { LogPane } from "../src/logWindow";
import { ArgoScreen, Detail, OverviewScreen, PinnedSplash, ResourceScreen, SearchModal, Sidebar, TopBar } from "../src/screens";
import { DEFAULT_KEYMAP } from "../src/keymap";
import { DEFAULT_THEME, BUILTIN_THEMES, themeTokens } from "../src/theme";
import type { Kubi } from "../src/useKubi";
import type { ClusterOverview, EventInfo, LogSnapshot, ResourceRow, Tab } from "../src/types";

const row = (
  uid: string,
  name: string,
  status: string,
  tone: ResourceRow["tone"],
  ready: string,
  restarts: string,
  node: string,
  ageSecs: number,
): ResourceRow => ({
  uid,
  name,
  namespace: "grafana",
  status,
  tone,
  ready,
  ageSecs,
  info: "",
  cells: { restarts, node },
  labels: [["app.kubernetes.io/name", "grafana"]],
  annotations: [["deployment.kubernetes.io/revision", "7"]],
  cpuMillis: 12.5,
  cpuRequestMillis: 100,
  memBytes: 134_217_728,
  memRequestBytes: 268_435_456,
});

const rows: ResourceRow[] = [
  row("u1", "grafana-deployment-85f7894766-qq7j4", "Running", "warn", "0/1", "12", "node-a", 900),
  row("u2", "grafana-deployment-844cd67f5b-dpxrs", "Running", "ok", "1/1", "0", "node-b", 5400),
  row("u3", "loki-distributor-6c9f7b8d4-2xk9p", "CrashLoopBackOff", "bad", "0/1", "47", "node-c", 320),
  row("u4", "tempo-querier-5f8d9c7b6-p4m2n", "ContainerCreating", "warn", "0/2", "0", "node-a", 8),
  row("u5", "prometheus-server-0", "Running", "ok", "2/2", "1", "node-d", 86_400),
  row("u6", "victoria-metrics-0", "Pending", "warn", "0/1", "0", "-", 45),
  row("u7", "argo-server-745d8f9d8f-6c4h6", "Running", "ok", "1/1", "0", "node-b", 1_640_000),
  row("u8", "metrics-server-854cff797b-dt4mm", "Running", "ok", "1/1", "1", "node-c", 1_640_000),
];

const events: EventInfo[] = [
  { kind: "Warning", reason: "Unhealthy", message: "Readiness probe failed: dial tcp 172.17.133.101:3000: connect: connection refused", count: 25, ageSecs: 78, source: "kubelet" },
  { kind: "Warning", reason: "BackOff", message: "Back-off restarting failed container grafana in pod grafana-deployment-85f7894766-qq7j4", count: 8, ageSecs: 240, source: "kubelet" },
  { kind: "Normal", reason: "Scheduled", message: "Successfully assigned grafana/grafana-deployment-85f7894766-qq7j4 to node-a", count: 1, ageSecs: 900, source: "default-scheduler" },
];

const overview: ClusterOverview = {
  context: "kz-mgmt",
  nodesReady: 5,
  nodesTotal: 6,
  pods: 148,
  podsRunning: 131,
  podsPending: 6,
  podsFailed: 3,
  podsSucceeded: 8,
  podsUnknown: 0,
  namespaces: 18,
  warningEvents: 7,
  warnings: [
    { object: "Pod/grafana-deployment-85f7894766-qq7j4", reason: "Unhealthy", message: "Readiness probe failed: connection refused", ageSecs: 78 },
    { object: "Pod/loki-distributor-6c9f7b8d4-2xk9p", reason: "BackOff", message: "Back-off restarting failed container", ageSecs: 240 },
  ],
  cpuMillis: 4820,
  cpuAllocatableMillis: 24_000,
  memBytes: 41_943_040_000,
  memAllocatableBytes: 100_663_296_000,
  note: null,
  argo: null,
};

const tab = (detailTab: Tab["detailTab"], selected: string | null): Tab =>
  ({
    id: 1,
    view: { kind: "resource", resource: "pods" },
    rows,
    selected,
    selection: selected == null ? [] : [selected],
    anchor: selected,
    detailTab,
    yaml: null,
    yamlFor: null,
    reveal: false,
    waiting: false,
    filter: "",
    sortKey: "name",
    sortAsc: true,
    namespace: "grafana",
    data: null,
    dataFor: null,
    events: selected == null ? null : events,
    eventsFor: selected,
    sources: null,
    sourcesFor: null,
    containers: null,
    containersFor: null,
    observedAt: Date.now(),
    context: "kz-mgmt",
    colWidths: {},
  });

const contexts = [
  { name: "kz-mgmt", cluster: "kz-mgmt", namespace: null, current: true },
  { name: "kz-dev", cluster: "kz-dev", namespace: null, current: false },
  { name: "prod-eu", cluster: "prod-eu", namespace: null, current: false },
  { name: "dev", cluster: "dev", namespace: null, current: false },
];

const noop = () => {};

/** A custom theme as the file would hold one, for the page that shows one. */
const CUSTOM_THEME = {
  id: "midnight",
  label: "Midnight",
  builtin: false,
  theme: { ...DEFAULT_THEME, base: "#101418", accent: "#e58ee0" },
};

function kubiFor(activeTab: Tab): Kubi {
  return {
    contexts,
    context: "kz-mgmt",
    namespaces: ["grafana", "kube-system", "argocd", "vm", "cert-manager"],
    tabs: [activeTab],
    clustered: false,
    active: 0,
    activeTab,
    home: "cluster",
    customResources: [],
    errors: [],
    refreshing: false,
    loadingConfig: false,
    connecting: false,
    overview,
    metricsNote: null,
    history: [
      { t: 0, cpu: 40, mem: 120 },
      { t: 1, cpu: 62, mem: 140 },
      { t: 2, cpu: 55, mem: 132 },
      { t: 3, cpu: 78, mem: 160 },
    ],
    now: Date.now(),
    dockTabs: [],
    activeDock: null,
    menu: null,
    ctxMenu: null,
    connectedContexts: ["kz-mgmt", "kz-dev"],
    clusterColors: {},
    contextWindows: [],
    pinned: null,
    pinnedGone: false,
    pinnedMissing: false,
    openContextWindow: noop,
    connectContext: noop,
    closeWindow: noop,
    searchOpen: false,
    settingsOpen: false,
    keymap: DEFAULT_KEYMAP,
    themes: BUILTIN_THEMES,
    activeTheme: "neutral",
    selectTheme: noop,
    saveTheme: noop,
    deleteTheme: noop,
    switchContext: noop,
    openView: noop,
    setFilter: noop,
    toggleSort: noop,
    selectRow: noop,
    clearSelection: noop,
    setDetailTab: noop,
    setNamespace: noop,
    openLogs: noop,
    openExec: noop,
    askForward: noop,
    restartSelected: noop,
    askDelete: noop,
    forwardServicePort: noop,
    setCreateYaml: noop,
    openCreate: noop,
    closeTab: noop,
    reorderTabs: noop,
    openMenu: noop,
    openContextMenu: noop,
    closeContextMenu: noop,
    disconnectContext: noop,
    setClusterColor: noop,
    openKubeconfig: async () => {},
    bindFilter: noop,
    setBinding: noop,
    resetBinding: noop,
    resetKeymap: noop,
    setSettingsOpen: noop,
    setSearchOpen: noop,
    warning: () => null,
    refresh: noop,
  } as unknown as Kubi;
}

function argoKubi(): Kubi {
  const kubi = kubiFor(tab("overview", null));
  const argo = {
    target: { name: "applications.argoproj.io", kind: "Application", group: "argoproj.io", version: "v1alpha1", plural: "applications", namespaced: true },
    apps: [
      { name: "apk-kz-sandbox", namespace: "argocd", project: "default", health: "Healthy", sync: "Synced" },
      { name: "processing-sandbox", namespace: "argocd", project: "default", health: "Progressing", sync: "OutOfSync" },
      { name: "grafana-kz-mgmt", namespace: "argocd", project: "infra", health: "Degraded", sync: "OutOfSync" },
      { name: "loki", namespace: "argocd", project: "infra", health: "Healthy", sync: "Synced" },
    ],
    appSets: [],
    setsTarget: null,
    repos: [{ name: "infra", url: "https://git.example.com/infra.git", repoType: "git", project: "infra" }],
    clusters: [{ name: "in-cluster", server: "https://kubernetes.default.svc" }],
    note: null,
    setsNote: null,
    reposNote: null,
    clustersNote: null,
  };
  return { ...kubi, home: "argo", overview: { ...overview, argo } } as Kubi;
}

const logs: LogSnapshot = {
  kind: "pods",
  namespace: "grafana",
  name: "loki-distributor-6c9f7b8d4-2xk9p",
  pods: ["loki-distributor-6c9f7b8d4-2xk9p"],
  pod: "loki-distributor-6c9f7b8d4-2xk9p",
  containers: ["loki", "istio-proxy"],
  container: "loki",
  lines: [
    "2026-10-12T16:02:11.114293847Z level=info msg=\"starting loki distributor\"",
    "2026-10-12T16:02:11.220981234Z level=info msg=\"server listening\" addr=0.0.0.0:3100",
    "2026-10-12T16:02:12.884210021Z level=warn msg=\"push request rejected\" err=\"entry too far behind\"",
    "2026-10-12T16:02:14.001920384Z level=error msg=\"failed to flush chunk\" err=\"context deadline exceeded\"",
    "2026-10-12T16:02:14.442810923Z level=info msg=\"retrying flush\" attempt=2",
  ],
  started: true,
  closed: false,
  previous: false,
  timestamps: true,
};

const shell = (activeTab: Tab, rail = true) => {
  const kubi = kubiFor(activeTab);
  return `<div class="app${rail ? "" : " no-rail"}">${renderToStaticMarkup(<TopBar kubi={kubi} />)}${
    rail ? renderToStaticMarkup(<ContextRail kubi={kubi} />) : ""
  }${renderToStaticMarkup(
    <Sidebar kubi={kubi} />,
  )}<main class="main">${renderToStaticMarkup(
    <ResourceScreen kubi={kubi} />,
  )}</main></div>`;
};

const listOnly = () => {
  const activeTab = tab("overview", null);
  const kubi = kubiFor(activeTab);
  return renderToStaticMarkup(<ResourceScreen kubi={kubi} />);
};

const detail = (detailTab: Tab["detailTab"], width = 460) => {
  const activeTab = tab(detailTab, "u1");
  const kubi = kubiFor(activeTab);
  return renderToStaticMarkup(<Detail kubi={kubi} width={width} onWidth={noop} />);
};

/** Every About state side by side: idle, busy, settled, and failed. */
const aboutStates = (): string => {
  const states: [string, AboutStatus][] = [
    ["Not checked yet", { kind: "idle" }],
    ["Checking", { kind: "checking" }],
    ["Up to date", { kind: "uptodate" }],
    ["Available", { kind: "available", version: "0.3.0" }],
    ["Downloading", { kind: "downloading", version: "0.3.0", done: 4_194_304, total: 12_582_912 }],
    ["Ready", { kind: "ready", version: "0.3.0" }],
    ["Failed", { kind: "failed", message: "Could not reach the releases page. Check the connection and try again." }],
  ];
  return `<div class="pv-side">${states
    .map(
      ([label, status]) =>
        `<section class="pv"><h3>${label}</h3><div class="settings-body" style="max-height:none">${renderToStaticMarkup(
          <About version="0.2.0" status={status} onCheck={noop} onDownload={noop} onRestart={noop} />,
        )}</div></section>`,
    )
    .join("")}</div>`;
};

/** The sidebar before anything is open: every section listed, none expanded. */
const freshSidebar = () =>
  renderToStaticMarkup(
    <Sidebar kubi={{ ...kubiFor(tab("overview", null)), active: null, activeTab: null } as Kubi} />,
  );

/** The context menu in both states, next to the row menu that shares its styles. */
const menus = () => {
  const base = kubiFor(tab("overview", null));
  const live = { ...base, connectedContexts: ["kz-mgmt"] } as Kubi;
  const idle = { ...base, connectedContexts: [], clusterColors: { "prod-eu": "#f778ba" } } as Kubi;
  const icon =
    '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 4h10M6.5 4V2.6h3V4M4.6 4l.6 9h5.6l.6-9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  return `<div class="pv-side">
    <div class="menu" style="position:relative">${renderToStaticMarkup(
      <ContextMenuBody kubi={live} name="kz-mgmt" />,
    )}</div>
    <div class="menu" style="position:relative">${renderToStaticMarkup(
      <ContextMenuBody kubi={idle} name="prod-eu" />,
    )}</div>
    <div class="menu" style="position:relative">
      <button>${icon} Logs</button>
      <button>${icon} Exec</button>
      <button>${icon} Port forward</button>
      <button class="bad">${icon} Delete</button>
    </div>
  </div>`;
};

const css = readFileSync(join(__dirname, "..", "src", "styles.css"), "utf8");
const page = (title: string, body: string, extra = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>${css}
/* Harness chrome only — never shipped. */
/* Page chrome only: never override the app's own body colors. */
body { margin: 0; background: #101114; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
/* A page is a still frame: the states are already set, so nothing should be
   caught mid-animation (a menu drawn on load would photograph half faded). */
*, *::before, *::after { animation: none !important; transition: none !important; }
.pv-page { padding: 20px; }
.pv h3 { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #8f97a6; }
.pv-frame { position: relative; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--bg); }
.pv-side { display: flex; gap: 20px; align-items: flex-start; }
.pv-side > * { flex: 1; min-width: 0; }
.pv-primitives { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 16px; background: var(--bg); }
${extra}
</style></head><body><div class="pv-page"><h3>${title}</h3><div class="pv-frame">${body}</div></div></body></html>`;

const pages: [string, string, string?][] = [
  ["Shell — topbar, context rail, sidebar, object list", shell(tab("overview", null))],
  ["Context window — shell without the rail", shell(tab("overview", null), false)],
  ["Object list — pods", listOnly()],
  ["Detail — overview with warnings", detail("overview")],
  ["Detail — events", detail("events")],
  ["Overview screen", renderToStaticMarkup(<OverviewScreen kubi={kubiFor(tab("overview", null))} />)],
  ["Argo screen", renderToStaticMarkup(<ArgoScreen kubi={argoKubi()} />)],
  ["Spotlight", renderToStaticMarkup(<SearchModal kubi={kubiFor(tab("overview", null))} />)],
  ["Menus — context and row", menus()],
  [
    "Context window — marked rail and splash",
    `<div class="pv-side">${renderToStaticMarkup(
      <ContextRail kubi={{ ...kubiFor(tab("overview", null)), contextWindows: ["kz-mgmt"] } as Kubi} />,
    )}${renderToStaticMarkup(
      <PinnedSplash kubi={{ ...kubiFor(tab("overview", null)), pinned: "prod-eu", pinnedGone: true } as Kubi} />,
    )}${renderToStaticMarkup(
      <PinnedSplash kubi={{ ...kubiFor(tab("overview", null)), pinned: "kz-dev", pinnedGone: false } as Kubi} />,
    )}</div>`,
  ],
  ["Sidebar — groups closed at start", freshSidebar()],
  ["Settings — about, every state", aboutStates()],
  ["Settings", renderToStaticMarkup(<SettingsModal kubi={kubiFor(tab("overview", null))} />)],
  [
    "Settings — colors",
    `<div class="settings-body" style="max-height:none">${renderToStaticMarkup(
      <Colors kubi={{ ...kubiFor(tab("overview", null)), theme: DEFAULT_THEME } as Kubi} />,
    )}</div>`,
  ],
  [
    "Settings — colors, custom theme",
    `<div class="settings-body" style="max-height:none">${renderToStaticMarkup(
      <Colors
        kubi={
          {
            ...kubiFor(tab("overview", null)),
            theme: CUSTOM_THEME.theme,
            themes: [...BUILTIN_THEMES, CUSTOM_THEME],
            activeTheme: CUSTOM_THEME.id,
          } as Kubi
        }
      />,
    )}</div>`,
  ],
  [
    "Shell — light theme",
    shell(tab("overview", null)),
    `:root { ${Object.entries(themeTokens({ ...DEFAULT_THEME, base: "#f4f5f7", mode: "light" }))
      .map(([name, value]) => `${name}: ${value};`)
      .join(" ")} }`,
  ],
  [
    "Log pane",
    `<div class="log-drawer log-window" style="height:360px">${renderToStaticMarkup(
      <LogPane logs={logs} follow={1} onPod={noop} onContainer={noop} onPrevious={noop} onTimestamps={noop} onClose={noop} />,
    )}</div>`,
  ],
  [
    "Primitives",
    `<div class="pv-primitives">
      <button>Default</button>
      <button class="create">Primary</button>
      <button class="icon" aria-label="Settings"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.6 1.9h2.8l.4 1.9 1.6-.9 2 2-1 1.6 1.9.5v2.8l-1.9.4 1 1.6-2 2-1.6-1-.4 1.9H6.6l-.4-1.9-1.6 1-2-2 1-1.6-1.9-.4V6.9l1.9-.5-1-1.6 2-2 1.6.9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button>
      <button disabled>Disabled</button>
      <input value="Filter" />
      <span class="badge warn">3</span>
      <span class="warn-mark"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 2.4 14.2 13H1.8z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></span>
      <kbd>Ctrl</kbd><kbd>A</kbd>
      <span class="muted">muted text</span>
    </div>`,
  ],
];

for (const [title, body, extra] of pages) {
  const name = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const file = join(__dirname, `page-${name}.html`);
  writeFileSync(file, page(title, body, extra));
  console.log("wrote", file);
}
