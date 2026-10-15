import { useEffect, useRef, useState } from "react";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { readSettingsFile, readThemeFile, readThemesFile, send, writeSettingsFile, writeThemesFile } from "./api";
import { currentWindowLabel, ownerSuffix } from "./windows";
import { setClusterColors } from "./format";
import {
  DEFAULT_KEYMAP,
  isTypedKey,
  matchesBinding,
  type Binding,
  type Keymap,
  type KeymapAction,
} from "./keymap";
import { parsePrefs, serializePrefs } from "./prefs";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  applyTheme,
  parseThemeFile,
  parseThemes,
  serializeThemes,
  uniqueThemeId,
  type NamedTheme,
  type Theme,
} from "./theme";
import type {
  AppEvent,
  ClusterOverview,
  ContextInfo,
  ContextMenu,
  CrTarget,
  Home,
  DockExec,
  DockLog,
  DockTab,
  ExecSnapshot,
  ForwardDraft,
  LogSnapshot,
  ObjectWarning,
  PendingDelete,
  PendingSelect,
  PortForward,
  ResourceKind,
  ResourceRow,
  RowMenu,
  Tab,
  View,
  WatchTarget,
} from "./types";
import { eventKey, eventScope, sameTarget, sameView, watchOf } from "./types";
import { canExec, canForward, canLogs, canRestart, logTitle, podSettled, viewTitle } from "./catalog";

type HistPoint = { t: number; cpu: number; mem: number };

/** A copy of a per-context map without one key. */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Warning scan throttle: refreshes at most this often while a list is open. */
const WARNINGS_TTL_MS = 8_000;
/** ...and at least this often, so badges do not go stale. */
const WARNINGS_REFRESH_MS = 20_000;

type Session = {
  context: string | null;
  active: number | null;
  tabs: Tab[];
  home: Home;
  pending: PendingSelect | null;
  /** Usage samples, keyed `context|namespace|name` so clusters never mix. */
  usage: Record<string, [number, number]>;
  /** Default namespace per context. */
  defaults: Record<string, string | null>;
  lastNamespace: string | null;
  nextId: number;
  started: number;
};

function blankTab(view: View, context: string, namespace: string | null, id: number): Tab {
  return {
    id,
    context,
    view,
    rows: [],
    selected: null,
    selection: [],
    anchor: null,
    detailTab: "overview",
    yaml: null,
    yamlFor: null,
    reveal: false,
    waiting: true,
    filter: "",
    sortKey: "name",
    sortAsc: true,
    namespace,
    data: null,
    dataFor: null,
    events: null,
    eventsFor: null,
    sources: null,
    sourcesFor: null,
    containers: null,
    containersFor: null,
    observedAt: null,
  };
}

const EXEC_TEXT_CAP = 200_000;

function clipExec(text: string): string {
  return text.length > EXEC_TEXT_CAP ? text.slice(text.length - EXEC_TEXT_CAP) : text;
}

function snapshotOf(tab: DockLog): LogSnapshot {
  return {
    kind: tab.kind,
    namespace: tab.namespace,
    name: tab.name,
    pods: tab.pods,
    pod: tab.pod,
    containers: tab.containers,
    container: tab.container,
    lines: tab.lines,
    started: tab.started,
    closed: tab.closed,
    previous: tab.previous,
    timestamps: tab.timestamps,
  };
}

function execSnapshotOf(tab: DockExec): ExecSnapshot {
  return {
    id: tab.id,
    namespace: tab.namespace,
    name: tab.name,
    containers: tab.containers,
    container: tab.container,
    text: tab.text,
    closed: tab.closed,
  };
}

function applyUsage(rows: ResourceRow[], context: string, usage: Record<string, [number, number]>): ResourceRow[] {
  return rows.map((row) => {
    const sample = usage[`${context}|${row.namespace}/${row.name}`];
    if (!sample) return row;
    return { ...row, cpuMillis: sample[0], memBytes: sample[1] };
  });
}

/**
 * Stream ids must be unique across every window of the process: the engine
 * keys a live stream by id alone. Each window draws a random base and counts
 * up from it, so no two windows ever hand the engine the same id.
 */
function streamIdBase(): number {
  return Math.floor(Math.random() * 2 ** 24) * 0x10000;
}

export function useKubi({ pinned = null }: { pinned?: string | null } = {}) {
  const session = useRef<Session>({
    context: null,
    active: null,
    tabs: [],
    home: "cluster",
    pending: null,
    usage: {},
    defaults: {},
    lastNamespace: null,
    nextId: 1,
    started: performance.now(),
  });
  const [contexts, setContexts] = useState<ContextInfo[]>([]);
  /** Context the window is browsing; tabs carry their own and can differ. */
  const [context, setContext] = useState<string | null>(null);
  /** Namespaces, custom resources and overview per context: one per cluster. */
  const [namespaces, setNamespaces] = useState<Record<string, string[]>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [home, setHome] = useState<Home>("cluster");
  const [customResources, setCustomResources] = useState<Record<string, CrTarget[]>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refreshStarted = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [overview, setOverview] = useState<Record<string, ClusterOverview>>({});
  const [metricsNote, setMetricsNote] = useState<string | null>(null);
  const [history, setHistory] = useState<HistPoint[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keymap, setKeymap] = useState<Keymap>(DEFAULT_KEYMAP);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  /** Every theme on offer: the shipped ones, then whatever the file holds. */
  const [themes, setThemes] = useState<NamedTheme[]>(BUILTIN_THEMES);
  /** Id of the theme the colors came from, or null once they were edited. */
  const [activeTheme, setActiveTheme] = useState<string | null>(DEFAULT_THEME_ID);
  /** Note for the Colors screen: what the last theme action did or refused. */
  const [themeNote, setThemeNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  /** Set by the open list so the filter shortcut has somewhere to point. */
  const focusFilter = useRef<(() => void) | null>(null);
  const [warnings, setWarnings] = useState<{ scope: string | null; byUid: Record<string, ObjectWarning> }>({
    scope: null,
    byUid: {},
  });
  const warningsAt = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createYaml, setCreateYaml] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dockTabs, setDockTabsState] = useState<DockTab[]>([]);
  const [activeDock, setActiveDockState] = useState<string | null>(null);
  const dockRef = useRef<DockTab[]>([]);
  const activeDockRef = useRef<string | null>(null);
  const logSeq = useRef(streamIdBase());
  const readyWindows = useRef(new Set<string>());
  const closingLabels = useRef(new Set<string>());
  const execWrites = useRef(new Map<string, (text: string) => void>());
  const dockActions = useRef<{
    ready: (label: string) => void;
    dock: (label: string) => void;
    close: (label: string) => void;
    pod: (label: string, pod: string) => void;
    container: (label: string, container: string) => void;
    previous: (label: string, value: boolean) => void;
    timestamps: (label: string, value: boolean) => void;
    input: (label: string, data: string) => void;
    resize: (label: string, cols: number, rows: number) => void;
    execContainer: (label: string, container: string) => void;
  }>({
    ready: () => {},
    dock: () => {},
    close: () => {},
    pod: () => {},
    container: () => {},
    previous: () => {},
    timestamps: () => {},
    input: () => {},
    resize: () => {},
    execContainer: () => {},
  });
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
  /** Context colors picked by hand; empty means "hue of the name". */
  const [colors, setColors] = useState<Record<string, string>>({});
  /** Contexts this window holds a connection to, so the menu can say so. */
  const [connected, setConnected] = useState<string[]>([]);
  /** The label of this window: the dock windows opened here answer to it. */
  const [ownLabel] = useState(currentWindowLabel);
  /** Contexts with a window of their own, so the rail can mark them. */
  const [contextWindows, setContextWindows] = useState<string[]>([]);
  const ctxWindowNames = useRef(new Map<string, string>());
  /** True in a context window whose context left the kubeconfig. */
  const [pinnedGone, setPinnedGone] = useState(false);
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [forwardDraft, setForwardDraft] = useState<ForwardDraft | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const forwardsRef = useRef<PortForward[]>([]);
  const forwardSeq = useRef(streamIdBase());
  const execSeq = useRef(streamIdBase());
  const applyKind = useRef<"create" | "patch">("create");
  /** The cluster the running apply works in, so another window's apply does not close this window's modal. */
  const applyContext = useRef("");

  function setDock(next: DockTab[]) {
    dockRef.current = next;
    setDockTabsState(next);
  }

  function setActiveDock(label: string | null) {
    activeDockRef.current = label;
    setActiveDockState(label);
  }

  function dockedTail(tabs: DockTab[]): string | null {
    return tabs.filter((tab) => !tab.detached).at(-1)?.label ?? null;
  }

  function setForwardList(next: PortForward[]) {
    forwardsRef.current = next;
    setForwards(next);
  }

  function pushError(message: string) {
    const text = message.trim();
    if (!text) return;
    setErrors((current) => (current[0] === text ? current : [text, ...current].slice(0, 4)));
  }

  function syncContextWindows() {
    setContextWindows([...ctxWindowNames.current.values()]);
  }

  function clearErrors() {
    setErrors([]);
  }

  function beginRefresh() {
    if (refreshTimer.current != null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    refreshingRef.current = true;
    refreshStarted.current = Date.now();
    setRefreshing(true);
  }

  function endRefresh() {
    if (!refreshingRef.current) return;
    refreshingRef.current = false;
    const wait = Math.max(0, 400 - (Date.now() - refreshStarted.current));
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      setRefreshing(false);
    }, wait);
  }

  function haltForwards() {
    if (forwardsRef.current.length === 0 && forwardDraft == null) {
      void send("stopPortForwards");
      return;
    }
    setForwardList([]);
    setForwardDraft(null);
    void send("stopPortForwards");
  }

  function findDock(label: string): DockTab | undefined {
    return dockRef.current.find((tab) => tab.label === label);
  }

  function haltPane(pane: "log" | "exec") {
    const open = dockRef.current.filter((tab) => tab.pane === pane && tab.detached);
    const next = dockRef.current.filter((tab) => tab.pane !== pane);
    for (const tab of dockRef.current) {
      if (tab.pane !== pane) continue;
      readyWindows.current.delete(tab.label);
      execWrites.current.delete(tab.label);
    }
    setDock(next);
    if (!next.some((tab) => tab.label === activeDockRef.current && !tab.detached)) {
      setActiveDock(dockedTail(next));
    }
    void send(pane === "log" ? "stopLogs" : "stopExecs");
    for (const tab of open) closeDockWindow(tab.label);
  }

  function closeDockWindow(label: string) {
    void WebviewWindow.getByLabel(label)
      .then((win) => win?.close())
      .catch(() => undefined);
  }

  function publishLog(tab: DockLog) {
    if (!tab.detached || !readyWindows.current.has(tab.label)) return;
    void emitTo(tab.label, "log-snapshot", snapshotOf(tab)).catch(() => undefined);
  }

  function publishExec(tab: DockExec) {
    if (!tab.detached || !readyWindows.current.has(tab.label)) return;
    void emitTo(tab.label, "exec-snapshot", execSnapshotOf(tab)).catch(() => undefined);
  }

  function deliverExec(tab: DockExec, chunk: string) {
    if (tab.detached) {
      if (readyWindows.current.has(tab.label)) {
        void emitTo(tab.label, "exec-data", { text: chunk }).catch(() => undefined);
      }
      return;
    }
    execWrites.current.get(tab.label)?.(chunk);
  }

  function dockTab(label: string) {
    if (closingLabels.current.delete(label)) return;
    readyWindows.current.delete(label);
    const tab = findDock(label);
    if (!tab || !tab.detached) return;
    setDock(dockRef.current.map((item) => (item.label === label ? { ...item, detached: false } : item)));
    setActiveDock(label);
  }

  function readyTab(label: string) {
    const tab = findDock(label);
    if (!tab || !tab.detached) return;
    readyWindows.current.add(label);
    if (tab.pane === "log") publishLog(tab);
    else publishExec(tab);
  }

  function closeFromWindow(label: string) {
    closingLabels.current.add(label);
    readyWindows.current.delete(label);
    execWrites.current.delete(label);
    const tab = findDock(label);
    if (tab) stopDock(tab);
    closeDockWindow(label);
  }

  function sameLog(tab: DockTab, kind: ResourceKind, namespace: string, name: string): tab is DockLog {
    return tab.pane === "log" && tab.kind === kind && tab.namespace === namespace && tab.name === name;
  }

  function beginStream(
    kind: ResourceKind,
    namespace: string,
    name: string,
    pod: string | null,
    container: string | null,
    prior: DockLog | null,
  ): DockLog {
    if (prior) void send({ stopLog: { id: prior.id } });
    logSeq.current += 1;
    const id = logSeq.current;
    const samePod = prior != null && (pod == null || pod === prior.pod);
    const previous = prior?.previous ?? false;
    const timestamps = prior?.timestamps ?? false;
    void send({
      startLogs: {
        context: session.current.context ?? "",
        id,
        kind,
        namespace,
        name,
        pod,
        container,
        previous,
        timestamps,
      },
    });
    return {
      pane: "log",
      id,
      label: prior?.label ?? `log-${id}${ownerSuffix(ownLabel)}`,
      detached: prior?.detached ?? false,
      kind,
      namespace,
      name,
      pods: prior ? prior.pods : [],
      pod: pod ?? prior?.pod ?? "",
      containers: samePod && prior ? prior.containers : [],
      container: container ?? (samePod && prior ? prior.container : ""),
      lines: [],
      started: false,
      closed: false,
      previous,
      timestamps,
    };
  }

  function replaceLog(current: DockLog, pod: string | null, container: string | null) {
    const tab = beginStream(current.kind, current.namespace, current.name, pod, container, current);
    setDock(dockRef.current.map((item) => (item.label === current.label ? tab : item)));
    publishLog(tab);
  }

  /** Restart the stream with different flags, keeping pod, container and window state. */
  function flagLog(current: DockLog, patch: Partial<Pick<DockLog, "previous" | "timestamps">>) {
    const tab = beginStream(
      current.kind,
      current.namespace,
      current.name,
      current.pod || null,
      current.container || null,
      { ...current, ...patch },
    );
    setDock(dockRef.current.map((item) => (item.label === current.label ? tab : item)));
    publishLog(tab);
  }

  function openResourceLogs(kind: ResourceKind, namespace: string, name: string) {
    const existing = dockRef.current.find((tab) => sameLog(tab, kind, namespace, name));
    if (existing && !existing.closed) {
      if (existing.detached) void focusWindow(existing.label);
      else setActiveDock(existing.label);
      return;
    }
    const tab = beginStream(kind, namespace, name, null, null, existing ?? null);
    setDock(
      existing
        ? dockRef.current.map((item) => (item.label === tab.label ? tab : item))
        : [...dockRef.current, tab],
    );
    if (tab.detached) {
      void focusWindow(tab.label);
      publishLog(tab);
    } else {
      setActiveDock(tab.label);
    }
  }

  function sameExec(tab: DockTab, namespace: string, name: string): tab is DockExec {
    return tab.pane === "exec" && tab.namespace === namespace && tab.name === name;
  }

  function beginExec(namespace: string, name: string, container: string | null, previous: DockExec | null): DockExec {
    if (previous) void send({ stopExec: { id: previous.id } });
    execSeq.current += 1;
    const id = execSeq.current;
    void send({
      startExec: { context: session.current.context ?? "", id, namespace, name, container },
    });
    return {
      pane: "exec",
      id,
      label: previous?.label ?? `exec-${id}${ownerSuffix(ownLabel)}`,
      detached: previous?.detached ?? false,
      namespace,
      name,
      containers: previous?.containers ?? [],
      container: container ?? previous?.container ?? "",
      text: "",
      closed: false,
    };
  }

  function openPodExec(namespace: string, name: string) {
    const existing = dockRef.current.find((tab) => sameExec(tab, namespace, name));
    if (existing && !existing.closed) {
      if (existing.detached) void focusWindow(existing.label);
      else setActiveDock(existing.label);
      return;
    }
    const tab = beginExec(namespace, name, null, existing ?? null);
    setDock(
      existing
        ? dockRef.current.map((item) => (item.label === tab.label ? tab : item))
        : [...dockRef.current, tab],
    );
    if (tab.detached) {
      void focusWindow(tab.label);
      publishExec(tab);
    } else {
      setActiveDock(tab.label);
    }
  }

  function setExecContainer(label: string, container: string) {
    const current = findDock(label);
    if (!current || current.pane !== "exec" || container === "" || container === current.container) return;
    const tab = beginExec(current.namespace, current.name, container, current);
    setDock(dockRef.current.map((item) => (item.label === label ? tab : item)));
    publishExec(tab);
  }

  function execInputLabel(label: string, data: string) {
    const tab = findDock(label);
    if (!tab || tab.pane !== "exec" || data === "") return;
    void send({ execInput: { id: tab.id, data } });
  }

  function execResizeLabel(label: string, cols: number, rows: number) {
    const tab = findDock(label);
    if (!tab || tab.pane !== "exec") return;
    void send({ execResize: { id: tab.id, cols, rows } });
  }

  function stopDock(tab: DockTab) {
    if (tab.pane === "log") void send({ stopLog: { id: tab.id } });
    else void send({ stopExec: { id: tab.id } });
    execWrites.current.delete(tab.label);
    const next = dockRef.current.filter((item) => item.label !== tab.label);
    setDock(next);
    if (activeDockRef.current === tab.label) setActiveDock(dockedTail(next));
  }

  function focusWindow(label: string) {
    void WebviewWindow.getByLabel(label)
      .then((win) => win?.setFocus())
      .catch(() => undefined);
  }

  /** A label cannot hold every character a context name can; the slug is only an address. */
  function contextWindowLabel(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/(^-|-$)/g, "");
    return `ctx-${slug === "" ? "window" : slug}`;
  }

  /**
   * Opens a context in a window of its own, or focuses the window it already
   * has: one context window per context. Opening connects the cluster if
   * nothing else already did; the connection stays when this window closes.
   */
  async function openContextWindow(name: string) {
    const mine = [...ctxWindowNames.current.entries()].find(([, context]) => context === name);
    if (mine) {
      focusWindow(mine[0]);
      return;
    }
    const base = contextWindowLabel(name);
    let label = base;
    // A different context with the same slug steps aside: two windows under
    // one label would be one window.
    for (let n = 2; ctxWindowNames.current.has(label); n += 1) label = `${base}-${n}`;
    const existing = await WebviewWindow.getByLabel(label).catch(() => null);
    if (existing) {
      // A leftover this window lost track of (a dev reload): focus it rather
      // than fail under its label.
      await existing.setFocus().catch(() => undefined);
      return;
    }
    const { x, y } = await cursorWindowPosition();
    const created = new WebviewWindow(label, {
      title: `Kubi — ${name}`,
      // The exact name rides in the URL, where every character a label cannot
      // hold survives untouched.
      url: `index.html?context=${encodeURIComponent(name)}`,
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 560,
      resizable: true,
      focus: true,
      preventOverflow: true,
      x,
      y,
    });
    void created.once("tauri://error", (event) => {
      ctxWindowNames.current.delete(label);
      syncContextWindows();
      const detail = event.payload;
      pushError(typeof detail === "string" && detail.trim() !== "" ? detail : "Could not open the window");
    }).catch(() => undefined);
    void created.once("tauri://destroyed", () => {
      ctxWindowNames.current.delete(label);
      syncContextWindows();
    }).catch(() => undefined);
    ctxWindowNames.current.set(label, name);
    syncContextWindows();
  }

  function dockTitle(tab: DockTab): string {
    if (tab.pane === "log") return logTitle(tab.kind, tab.namespace, tab.name);
    return tab.namespace ? `Exec ${tab.namespace}/${tab.name}` : `Exec ${tab.name}`;
  }

  /** A new window opens at the pointer, so it lands where the click was. */
  async function cursorWindowPosition(): Promise<{ x: number; y: number }> {
    let x = 96;
    let y = 96;
    try {
      const cursor = await cursorPosition();
      const scale = await getCurrentWindow().scaleFactor();
      const factor = scale > 0 ? scale : 1;
      x = Math.round(cursor.x / factor - 24);
      y = Math.round(cursor.y / factor - 16);
    } catch {
      // Keep the fallback near the top-left of the screen.
    }
    return { x, y };
  }

  async function openDockWindow(tab: DockTab, size: { width: number; height: number }) {
    const existing = await WebviewWindow.getByLabel(tab.label).catch(() => null);
    if (existing) {
      await existing.setFocus().catch(() => undefined);
      const current = findDock(tab.label);
      if (current?.pane === "log") publishLog(current);
      if (current?.pane === "exec") publishExec(current);
      return;
    }
    const { x, y } = await cursorWindowPosition();
    const created = new WebviewWindow(tab.label, {
      title: dockTitle(tab),
      width: Math.max(360, Math.round(size.width)),
      height: Math.max(160, Math.round(size.height)),
      minWidth: 360,
      minHeight: 160,
      x,
      y,
      resizable: true,
      focus: true,
      preventOverflow: true,
    });
    void created.once("tauri://error", (event) => {
      readyWindows.current.delete(tab.label);
      dockTab(tab.label);
      const detail = event.payload;
      pushError(typeof detail === "string" && detail.trim() !== "" ? detail : "Could not open the window");
    }).catch(() => undefined);
    void created.once("tauri://destroyed", () => {
      dockTab(tab.label);
    }).catch(() => undefined);
  }

  function detachDock(label: string, size: { width: number; height: number }) {
    const current = findDock(label);
    if (!current || current.detached) return;
    const next = dockRef.current.map((tab) => (tab.label === label ? { ...tab, detached: true } : tab));
    setDock(next);
    if (activeDockRef.current === label) setActiveDock(dockedTail(next));
    void openDockWindow(current, size);
  }

  function reorderDock(fromVisible: number, toVisible: number) {
    if (fromVisible === toVisible) return;
    const items = dockRef.current.slice();
    const visible = items.flatMap((tab, index) => (tab.detached ? [] : [index]));
    const from = visible[fromVisible];
    const to = visible[toVisible];
    if (from == null || to == null || from === to) return;
    const [moved] = items.splice(from, 1);
    if (!moved) return;
    items.splice(to, 0, moved);
    setDock(items);
  }

  function showDetail(detailTab: Tab["detailTab"]) {
    const index = session.current.active;
    if (index == null) return;
    updateTabs((items) => items.map((item, i) => (i === index ? { ...item, detailTab } : item)));
    if (detailTab === "events") requestEvents(index);
    if (detailTab === "sources") requestSources(index);
    // Reopening Overview refreshes the container statuses without another click.
    if (detailTab === "overview") {
      const tab = session.current.tabs[index];
      if (tab?.view.kind === "resource" && tab.view.resource === "pods") requestPodContainers(index);
    }
  }

  function commitTabs(next: Tab[]) {
    session.current.tabs = next;
    setTabs(next);
  }

  /**
   * Drops every tab of one cluster after the engine dropped the cluster itself.
   * Its watches are already stopped there, so this only moves the window off
   * them: the front tab follows a survivor, or nothing when none is left.
   */
  function dropTabsOf(context: string) {
    const before = session.current.tabs;
    const front = session.current.active == null ? null : (before[session.current.active] ?? null);
    const remaining = before.filter((tab) => tab.context !== context);
    if (remaining.length === before.length) return;
    commitTabs(remaining);
    if (remaining.length === 0) {
      session.current.active = null;
      setActive(null);
      return;
    }
    const kept = front != null && front.context !== context ? remaining.indexOf(front) : -1;
    const index = kept >= 0 ? kept : remaining.length - 1;
    session.current.active = index;
    setActive(index);
  }

  function reorderTabs(from: number, to: number) {
    const items = session.current.tabs;
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
    const activeId = session.current.active == null ? null : (items[session.current.active]?.id ?? null);
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    commitTabs(next);
    if (activeId == null) return;
    const index = next.findIndex((item) => item.id === activeId);
    if (index < 0 || index === session.current.active) return;
    session.current.active = index;
    setActive(index);
  }

  function updateTabs(fn: (tabs: Tab[]) => Tab[]) {
    commitTabs(fn(session.current.tabs));
  }

  function inherited(): string | null {
    const current = session.current;
    if (current.active != null) return current.tabs[current.active]?.namespace ?? null;
    if (current.tabs.length === 0) return current.defaults[current.context ?? ""] ?? null;
    return current.lastNamespace;
  }

  function requestYaml(index = session.current.active) {
    if (index == null) return;
    const tab = session.current.tabs[index];
    const target = tab ? watchOf(tab.view) : null;
    const row = tab?.rows.find((item) => item.uid === tab.selected);
    if (!tab || !target || !row) return;
    void send({
      fetchYaml: {
        context: tab.context,
        target,
        namespace: row.namespace,
        name: row.name,
        uid: row.uid,
        revealSecrets: tab.reveal,
      },
    });
  }

  /**
   * Loads the events the cluster attached to the selected row. Called as soon
   * as a row is focused, so warnings surface without opening the Events tab;
   * older events stay on screen while a refresh is in flight.
   */
  function requestEvents(index = session.current.active) {
    if (index == null) return;
    const tab = session.current.tabs[index];
    const row = tab?.rows.find((item) => item.uid === tab.selected);
    if (!tab || !row) return;
    updateTabs((items) =>
      items.map((item, i) =>
        i === index
          ? { ...item, events: item.eventsFor === row.uid ? item.events : null, eventsFor: row.uid }
          : item,
      ),
    );
    void send({
      fetchEvents: { context: tab.context, namespace: row.namespace, name: row.name, uid: row.uid },
    });
  }

  /**
   * Scans warning events once for the whole list, so rows carry a badge before
   * anything is selected. Throttled: the watch pushes rows often.
   */
  function requestWarnings(force = false) {
    const index = session.current.active;
    const tab = index == null ? null : session.current.tabs[index];
    if (!tab) return;
    const now = Date.now();
    if (!force && now - warningsAt.current < WARNINGS_TTL_MS) return;
    warningsAt.current = now;
    void send({ fetchWarnings: { context: tab.context, namespace: tab.namespace } });
  }

  /** Reads the ConfigMaps and Secrets the selected pod refers to. */
  function requestSources(index = session.current.active) {
    if (index == null) return;
    const tab = session.current.tabs[index];
    const row = tab?.rows.find((item) => item.uid === tab.selected);
    if (!tab || !row) return;
    updateTabs((items) =>
      items.map((item, i) => (i === index ? { ...item, sources: null, sourcesFor: row.uid } : item)),
    );
    void send({
      fetchPodSources: {
        context: tab.context,
        namespace: row.namespace,
        name: row.name,
        uid: row.uid,
        reveal: tab.reveal,
      },
    });
  }

  /** Reads spec facts and live status of every container of the selected pod. */
  function requestPodContainers(index = session.current.active) {
    if (index == null) return;
    const tab = session.current.tabs[index];
    const row = tab?.rows.find((item) => item.uid === tab.selected);
    if (!tab || !row) return;
    updateTabs((items) =>
      items.map((item, i) => (i === index ? { ...item, containers: null, containersFor: row.uid } : item)),
    );
    void send({
      fetchPodContainers: {
        context: tab.context,
        namespace: row.namespace,
        name: row.name,
        uid: row.uid,
        reveal: tab.reveal,
      },
    });
  }

  function activate(index: number) {
    const tab = session.current.tabs[index];
    if (!tab) return;
    session.current.active = index;
    // The window follows the tab, so the rail and the sidebar agree with it.
    session.current.context = tab.context;
    setActive(index);
    setContext(tab.context);
    const target = watchOf(tab.view);
    if (!target) return;
    updateTabs((items) => items.map((item, i) => (i === index ? { ...item, waiting: true } : item)));
    void send({ setNamespace: { context: tab.context, namespace: tab.namespace } });
    void send({ watch: { context: tab.context, target } });
    if (tab.detailTab === "events") requestEvents(index);
    if (tab.detailTab === "sources") requestSources(index);
  }

  function showHome(next: Home) {
    if (session.current.active == null && session.current.home === next) return;
    const current = session.current.context;
    session.current.home = next;
    session.current.active = null;
    setHome(next);
    setActive(null);
    if (!current) return;
    void send({ stopWatch: { context: current } });
    void send({ fetchOverview: { context: current } });
  }

  /** Point one tab at another namespace and restart its watch. */
  function applyNamespace(index: number, namespace: string | null) {
    const tab = session.current.tabs[index];
    if (!tab || tab.namespace === namespace) return;
    session.current.lastNamespace = namespace;
    setMenu(null);
    updateTabs((items) =>
      items.map((item, i) =>
        i === index
          ? {
              ...item,
              namespace,
              rows: [],
              selected: null,
              selection: [],
              anchor: null,
              yaml: null,
              yamlFor: null,
              data: null,
              dataFor: null,
              events: null,
              eventsFor: null,
              sources: null,
              sourcesFor: null,
              containers: null,
              containersFor: null,
              waiting: true,
            }
          : item,
      ),
    );
    session.current.usage = {};
    setHistory([]);
    const target = watchOf(session.current.tabs[index]?.view ?? tab.view);
    void send({ setNamespace: { context: tab.context, namespace } });
    if (target) void send({ watch: { context: tab.context, target } });
  }

  function openView(view: View, namespace?: string | null) {
    if (view.kind === "overview") {
      showHome("cluster");
      return;
    }
    if (view.kind === "argo") {
      showHome("argo");
      return;
    }
    const existing = session.current.tabs.findIndex(
      (tab) => tab.context === session.current.context && sameView(tab.view, view),
    );
    if (existing >= 0) {
      if (namespace != null && session.current.tabs[existing]?.namespace !== namespace) {
        if (session.current.active !== existing) activate(existing);
        applyNamespace(existing, namespace);
        return;
      }
      if (session.current.active === existing) return;
      activate(existing);
      return;
    }
    const tab = blankTab(view, session.current.context ?? "", namespace === undefined ? inherited() : namespace, session.current.nextId);
    session.current.nextId += 1;
    commitTabs([...session.current.tabs, tab]);
    activate(session.current.tabs.length - 1);
  }

  function selectPending() {
    const pending = session.current.pending;
    if (!pending) return;
    const index = session.current.tabs.findIndex((tab) => {
      const target = watchOf(tab.view);
      return target != null && sameTarget(target, pending.target);
    });
    if (index < 0) return;
    const row = session.current.tabs[index]?.rows.find(
      (item) => item.name === pending.name && item.namespace === pending.namespace,
    );
    if (!row) return;
    session.current.pending = null;
    if (session.current.active !== index) activate(index);
    selectUid(row.uid, index);
  }

  function sameIds(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((uid, index) => uid === right[index]);
  }

  function focusRow(index: number, uid: string, selection: string[], anchor: string | null) {
    const tab = session.current.tabs[index];
    if (!tab) return;
    const focusChanged = tab.selected !== uid;
    if (!focusChanged && sameIds(tab.selection, selection) && tab.anchor === anchor) return;
    updateTabs((items) =>
      items.map((item, i) =>
        i === index
          ? {
              ...item,
              selected: uid,
              selection,
              anchor,
              ...(focusChanged
                ? {
                    yaml: null,
                    yamlFor: null,
                    data: null,
                    dataFor: null,
                    events: null,
                    eventsFor: null,
                    sources: null,
                    sourcesFor: null,
                    containers: null,
                    containersFor: null,
                    detailTab: "overview" as const,
                  }
                : {}),
            }
          : item,
      ),
    );
    if (focusChanged) {
      setHistory([]);
      requestYaml(index);
      requestEvents(index);
      if (tab.view.kind === "resource" && tab.view.resource === "pods") requestPodContainers(index);
    }
  }

  function selectUid(uid: string, index = session.current.active) {
    if (index == null) return;
    focusRow(index, uid, [uid], uid);
  }

  function selectedRows(tab: Tab): ResourceRow[] {
    const ids = tab.selection.length > 0 ? tab.selection : tab.selected ? [tab.selected] : [];
    const byId = new Map(tab.rows.map((row) => [row.uid, row]));
    return ids.flatMap((uid) => {
      const row = byId.get(uid);
      return row ? [row] : [];
    });
  }

  function startForward(draft: {
    namespace: string;
    name: string;
    kind: ResourceKind;
    localPort: number;
    remotePort: number;
  }) {
    forwardSeq.current += 1;
    const id = forwardSeq.current;
    setForwardList([
      ...forwardsRef.current,
      {
        id,
        namespace: draft.namespace,
        name: draft.name,
        localPort: draft.localPort,
        remotePort: draft.remotePort,
      },
    ]);
    void send({
      startPortForward: {
        context: session.current.context ?? "",
        id,
        namespace: draft.namespace,
        name: draft.name,
        kind: draft.kind,
        localPort: draft.localPort,
        remotePort: draft.remotePort,
      },
    });
  }

  /**
   * Browsing a cluster is a focus change now: tabs of other clusters stay open,
   * and so do their watches, log streams and port forwards.
   */
  function switchContext(name: string) {
    if (session.current.context === name) return;
    session.current.context = name;
    session.current.lastNamespace = null;
    session.current.pending = null;
    setContext(name);
    setPendingDelete(null);
    setMenu(null);
    setCtxMenu(null);
    setCreateOpen(false);
    setCreateError(null);
    setCreateBusy(false);
    setSearchOpen(false);
    setHistory([]);
    setMetricsNote(null);
    // A cluster that already has tabs keeps its place: focus the newest one.
    const mine = session.current.tabs.flatMap((tab, index) => (tab.context === name ? [index] : []));
    const last = mine[mine.length - 1];
    if (last != null) {
      activate(last);
      return;
    }
    session.current.home = "cluster";
    session.current.active = null;
    setActive(null);
    setHome("cluster");
    setConnecting(true);
    void send({ connect: { context: name } });
  }

  function pushHistory(namespace: string, name: string, cpu: number, mem: number) {
    const index = session.current.active;
    const tab = index == null ? undefined : session.current.tabs[index];
    const row = tab?.rows.find((item) => item.uid === tab.selected);
    if (!row || row.namespace !== namespace || row.name !== name) return;
    const point = { t: (performance.now() - session.current.started) / 1000, cpu, mem };
    setHistory((points) => {
      const next = [...points];
      const last = next[next.length - 1];
      if (last && point.t - last.t < 1) next[next.length - 1] = point;
      else next.push(point);
      return next.slice(-60);
    });
  }

  const handleRef = useRef<(event: AppEvent) => void>(() => {});
  handleRef.current = (event) => {
    // A context window shares the broadcast with every window of the process;
    // only its own cluster is its business. The stream events are keyed by
    // stream id, which is unique per window, so they guard themselves.
    if (pinned != null) {
      const scope = eventScope(event);
      if (scope != null && scope !== pinned) return;
    }
    const key = eventKey(event);
    if (key === "contexts" && "contexts" in event) {
      setLoadingConfig(false);
      clearErrors();
      setContexts(event.contexts);
      // A context that left the kubeconfig cannot stay "connected" here.
      const names = new Set(event.contexts.map((item) => item.name));
      setConnected((list) => list.filter((name) => names.has(name)));
      if (event.contexts.length === 0) {
        setConnecting(false);
        setCustomResources({});
        setPinnedGone(pinned != null);
        return;
      }
      if (pinned != null) {
        // A context window browses its own cluster and nothing else. Opening it
        // connects that cluster if nothing else already did; a repeat connect
        // is safe, the engine restarts the catalog and streams keep their ids.
        const still = event.contexts.some((item) => item.name === pinned);
        setPinnedGone(!still);
        if (!still) return;
        if (session.current.context !== pinned) {
          session.current.context = null;
          switchContext(pinned);
        } else if (!connected.includes(pinned)) {
          // Back after a disconnect or a kubeconfig round-trip.
          setConnecting(true);
          void send({ connect: { context: pinned } });
        }
        return;
      }
      const current = session.current.context;
      const pick =
        (current && event.contexts.some((item) => item.name === current) ? current : null) ??
        event.contexts.find((item) => item.current)?.name ??
        event.contexts[0]?.name;
      if (pick) {
        session.current.context = null;
        switchContext(pick);
      }
      return;
    }
    if (key === "connected" && "connected" in event) {
      const from = event.connected.context;
      // Worth remembering even when another cluster is the one in front.
      setConnected((names) => (names.includes(from) ? names : [...names, from]));
      if (session.current.context !== from) return;
      setNamespaces((all) => ({ ...all, [from]: event.connected.namespaces }));
      session.current.defaults[from] = event.connected.defaultNamespace;
      setConnecting(false);
      clearErrors();
      void send({ fetchOverview: { context: from } });
      return;
    }
    if (key === "disconnected" && "disconnected" in event) {
      const gone = event.disconnected.context;
      setConnected((names) => names.filter((name) => name !== gone));
      // Whatever the window kept for that cluster goes with it.
      setNamespaces((all) => omit(all, gone));
      setCustomResources((all) => omit(all, gone));
      setOverview((all) => omit(all, gone));
      setCtxMenu(null);
      dropTabsOf(gone);
      if (session.current.context === gone) {
        if (pinned != null) {
          // A context window does not drift to another cluster: its splash
          // offers to connect this one again.
          return;
        }
        // The window follows the tab left in front, or another context entirely.
        const front = session.current.active == null ? null : session.current.tabs[session.current.active];
        const next =
          front?.context ?? contexts.find((item) => item.name !== gone)?.name ?? null;
        if (next) switchContext(next);
        else {
          session.current.context = null;
          setContext(null);
        }
      }
      return;
    }
    if (key === "error" && "error" in event) {
      pushError(event.error);
      endRefresh();
      setConnecting(false);
      setLoadingConfig(false);
      return;
    }
    if (key === "customResources" && "customResources" in event) {
      if (session.current.context !== event.customResources.context) return;
      const from = event.customResources.context;
      setCustomResources((all) => ({ ...all, [from]: event.customResources.targets }));
      return;
    }
    if (key === "rows" && "rows" in event) {
      const { context: from, target, rows } = event.rows;
      const withUsage = applyUsage(rows, from, session.current.usage);
      const observedAt = Date.now();
      const live = new Set(withUsage.map((row) => row.uid));
      const refreshYaml: number[] = [];
      updateTabs((items) =>
        items.map((tab, index) => {
          const watching = watchOf(tab.view);
          // Rows belong to one cluster: a watch in another must not claim them.
          if (!watching || tab.context !== from || !sameTarget(watching, target)) return tab;
          const selection = tab.selection.filter((uid) => live.has(uid));
          const selected = tab.selected != null && live.has(tab.selected) ? tab.selected : (selection[0] ?? null);
          const anchor = tab.anchor != null && live.has(tab.anchor) ? tab.anchor : selected;
          const focusedGone = tab.selected !== selected;
          if (focusedGone && selected) refreshYaml.push(index);
          return {
            ...tab,
            rows: withUsage,
            waiting: false,
            observedAt,
            selection,
            selected,
            anchor,
            ...(focusedGone ? { yaml: null, yamlFor: null, data: null, dataFor: null } : {}),
          };
        }),
      );
      for (const index of refreshYaml) requestYaml(index);
      selectPending();
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      const watching = tab ? watchOf(tab.view) : null;
      if (watching && sameTarget(watching, target)) {
        endRefresh();
        requestWarnings();
      }
      return;
    }
    if (key === "usage" && "usage" in event) {
      const from = event.usage.context;
      for (const sample of event.usage.samples) {
        session.current.usage[`${from}|${sample.namespace}/${sample.name}`] = [sample.cpuMillis, sample.memBytes];
      }
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      if (tab?.context === from && tab.view.kind === "resource" && tab.view.resource === event.usage.kind) {
        updateTabs((items) =>
          items.map((item, i) =>
            i === index ? { ...item, rows: applyUsage(item.rows, from, session.current.usage) } : item,
          ),
        );
        const selected = session.current.tabs[index ?? -1]?.rows.find((row) => row.uid === tab.selected);
        const sample = event.usage.samples.find(
          (item) => item.namespace === selected?.namespace && item.name === selected?.name,
        );
        if (sample) pushHistory(sample.namespace, sample.name, sample.cpuMillis, sample.memBytes);
      }
      return;
    }
    if (key === "metricsUnavailable" && "metricsUnavailable" in event) {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      if (
        tab?.context === event.metricsUnavailable.context &&
        tab.view.kind === "resource" &&
        tab.view.resource === event.metricsUnavailable.kind
      ) {
        setMetricsNote(event.metricsUnavailable.message);
      }
      return;
    }
    if (key === "yaml" && "yaml" in event) {
      updateTabs((items) =>
        items.map((tab) =>
          tab.context === event.yaml.context && tab.selected === event.yaml.uid
            ? { ...tab, yaml: event.yaml.yaml, yamlFor: event.yaml.uid }
            : tab,
        ),
      );
      return;
    }
    if (key === "objectData" && "objectData" in event) {
      updateTabs((items) =>
        items.map((tab) =>
          tab.context === event.objectData.context && tab.selected === event.objectData.uid
            ? { ...tab, data: event.objectData.entries, dataFor: event.objectData.uid }
            : tab,
        ),
      );
      return;
    }
    if (key === "objectEvents" && "objectEvents" in event) {
      const { context: from, uid, events } = event.objectEvents;
      updateTabs((items) =>
        items.map((tab) => (tab.context === from && tab.eventsFor === uid ? { ...tab, events } : tab)),
      );
      return;
    }
    if (key === "podSources" && "podSources" in event) {
      const { context: from, uid, mounts, env } = event.podSources;
      updateTabs((items) =>
        items.map((tab) =>
          tab.context === from && tab.sourcesFor === uid ? { ...tab, sources: { mounts, env } } : tab,
        ),
      );
      return;
    }
    if (key === "podContainers" && "podContainers" in event) {
      const { context: from, uid, containers } = event.podContainers;
      updateTabs((items) =>
        items.map((tab) => (tab.context === from && tab.containersFor === uid ? { ...tab, containers } : tab)),
      );
      return;
    }
    if (key === "warnings" && "warnings" in event) {
      // Another window refreshes the warnings of the cluster it browses; the
      // markers here belong to the cluster in front.
      if (event.warnings.context !== session.current.context) return;
      const byUid: Record<string, ObjectWarning> = {};
      for (const item of event.warnings.objects) byUid[item.uid] = item;
      setWarnings({ scope: `${event.warnings.context}|${event.warnings.namespace ?? ""}`, byUid });
      return;
    }
    if (key === "applyResult" && "applyResult" in event) {
      // Another window of the process may have applied in another cluster; a
      // busy modal here must not close for someone else's apply.
      if (applyContext.current !== event.applyResult.context) return;
      setCreateBusy(false);
      if (applyKind.current === "patch") {
        setPatchError(event.applyResult.error);
        if (!event.applyResult.error) requestYaml();
        return;
      }
      if (event.applyResult.error) {
        setCreateError(event.applyResult.error);
      } else {
        setCreateOpen(false);
        setCreateError(null);
        const index = session.current.active;
        const tab = index == null ? undefined : session.current.tabs[index];
        const target = tab ? watchOf(tab.view) : null;
        if (tab && target) {
          void send({ setNamespace: { context: tab.context, namespace: tab.namespace } });
          void send({ watch: { context: tab.context, target } });
        }
      }
      return;
    }
    if (key === "overview" && "overview" in event) {
      const from = event.overview.context;
      setOverview((all) => ({ ...all, [from]: event.overview.overview }));
      if (session.current.active == null && session.current.context === from) endRefresh();
      return;
    }
    if (key === "logStarted" && "logStarted" in event) {
      const started = event.logStarted;
      const next = dockRef.current.map((tab) =>
        tab.pane === "log" && tab.id === started.id
          ? {
              ...tab,
              pods: started.pods,
              pod: started.pod,
              containers: started.containers,
              container: started.container,
              lines: [],
              started: true,
              closed: false,
            }
          : tab,
      );
      setDock(next);
      const opened = next.find((tab) => tab.pane === "log" && tab.id === started.id);
      if (opened?.pane === "log") publishLog(opened);
      return;
    }
    if (key === "logLine" && "logLine" in event) {
      const next = dockRef.current.map((tab) => {
        if (tab.pane !== "log" || tab.id !== event.logLine.id) return tab;
        const prior = tab.lines.length >= 4000 ? tab.lines.slice(-3999) : tab.lines;
        return { ...tab, lines: [...prior, event.logLine.line] };
      });
      setDock(next);
      const updated = next.find((tab) => tab.pane === "log" && tab.id === event.logLine.id);
      if (updated?.pane === "log" && updated.detached && readyWindows.current.has(updated.label)) {
        void emitTo(updated.label, "log-line", { line: event.logLine.line }).catch(() => undefined);
      }
      return;
    }
    if (key === "logClosed" && "logClosed" in event) {
      const next = dockRef.current.map((tab) =>
        tab.pane === "log" && tab.id === event.logClosed.id ? { ...tab, closed: true, started: true } : tab,
      );
      setDock(next);
      const closed = next.find((tab) => tab.pane === "log" && tab.id === event.logClosed.id);
      if (closed?.pane === "log") publishLog(closed);
      return;
    }
    if (key === "portForwardStarted" && "portForwardStarted" in event) {
      const started = event.portForwardStarted;
      setForwardList(
        forwardsRef.current.map((item) =>
          item.id === started.id
            ? { ...item, localPort: started.localPort, remotePort: started.remotePort }
            : item,
        ),
      );
      return;
    }
    if (key === "portForwardClosed" && "portForwardClosed" in event) {
      setForwardList(forwardsRef.current.filter((item) => item.id !== event.portForwardClosed.id));
      return;
    }
    if (key === "execStarted" && "execStarted" in event) {
      const started = event.execStarted;
      const next = dockRef.current.map((tab) =>
        tab.pane === "exec" && tab.id === started.id
          ? { ...tab, containers: started.containers, container: started.container, closed: false }
          : tab,
      );
      setDock(next);
      const opened = next.find((tab) => tab.pane === "exec" && tab.id === started.id);
      if (opened?.pane === "exec") publishExec(opened);
      return;
    }
    if (key === "execData" && "execData" in event) {
      const chunk = event.execData.text;
      let updated: DockExec | null = null;
      const next = dockRef.current.map((tab) => {
        if (tab.pane !== "exec" || tab.id !== event.execData.id) return tab;
        updated = { ...tab, text: clipExec(tab.text + chunk) };
        return updated;
      });
      setDock(next);
      if (updated) deliverExec(updated, chunk);
      return;
    }
    if (key === "execClosed" && "execClosed" in event) {
      const next = dockRef.current.map((tab) =>
        tab.pane === "exec" && tab.id === event.execClosed.id ? { ...tab, closed: true } : tab,
      );
      setDock(next);
      const closed = next.find((tab) => tab.pane === "exec" && tab.id === event.execClosed.id);
      if (closed?.pane === "exec") publishExec(closed);
    }
  };

  dockActions.current = {
    ready: readyTab,
    dock: dockTab,
    close: closeFromWindow,
    pod: (label, pod) => {
      const current = findDock(label);
      if (!current || current.pane !== "log" || pod === "" || pod === current.pod) return;
      replaceLog(current, pod, null);
    },
    container: (label, container) => {
      const current = findDock(label);
      if (!current || current.pane !== "log" || container === current.container) return;
      replaceLog(current, current.pod || null, container);
    },
    previous: (label, value) => {
      const current = findDock(label);
      if (!current || current.pane !== "log" || current.previous === value) return;
      flagLog(current, { previous: value });
    },
    timestamps: (label, value) => {
      const current = findDock(label);
      if (!current || current.pane !== "log" || current.timestamps === value) return;
      flagLog(current, { timestamps: value });
    },
    input: execInputLabel,
    resize: execResizeLabel,
    execContainer: setExecContainer,
  };

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let stop = false;
    let unlisten: (() => void) | undefined;
    void listen<AppEvent>("kubi", (message) => {
      handleRef.current(message.payload);
    }).then((fn) => {
      if (stop) {
        fn();
        return;
      }
      unlisten = fn;
      void send("loadContexts").catch((err: unknown) => {
        setLoadingConfig(false);
        pushError(err instanceof Error ? err.message : "Kubi core is not connected");
      });
    });
    return () => {
      stop = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const unlist: Array<() => void> = [];
    void (async () => {
      // The dock windows this window opens answer to it, not to "main": the
      // owner rides in their labels.
      const fns = await Promise.all([
        listen<{ label: string }>("log-ready", (event) => dockActions.current.ready(event.payload.label), {
          target: ownLabel,
        }),
        listen<{ label: string }>("log-dock", (event) => dockActions.current.dock(event.payload.label), {
          target: ownLabel,
        }),
        listen<{ label: string }>("log-close", (event) => dockActions.current.close(event.payload.label), {
          target: ownLabel,
        }),
        listen<{ label: string; pod: string }>(
          "log-pod",
          (event) => dockActions.current.pod(event.payload.label, event.payload.pod),
          { target: ownLabel },
        ),
        listen<{ label: string; container: string }>(
          "log-container",
          (event) => dockActions.current.container(event.payload.label, event.payload.container),
          { target: ownLabel },
        ),
        listen<{ label: string; value: boolean }>(
          "log-previous",
          (event) => dockActions.current.previous(event.payload.label, event.payload.value),
          { target: ownLabel },
        ),
        listen<{ label: string; value: boolean }>(
          "log-timestamps",
          (event) => dockActions.current.timestamps(event.payload.label, event.payload.value),
          { target: ownLabel },
        ),
        listen<{ label: string }>("exec-ready", (event) => dockActions.current.ready(event.payload.label), {
          target: ownLabel,
        }),
        listen<{ label: string }>("exec-close", (event) => dockActions.current.close(event.payload.label), {
          target: ownLabel,
        }),
        listen<{ label: string; data: string }>(
          "exec-input",
          (event) => dockActions.current.input(event.payload.label, event.payload.data),
          { target: ownLabel },
        ),
        listen<{ label: string; cols: number; rows: number }>(
          "exec-resize",
          (event) => dockActions.current.resize(event.payload.label, event.payload.cols, event.payload.rows),
          { target: ownLabel },
        ),
        listen<{ label: string; container: string }>(
          "exec-container",
          (event) => dockActions.current.execContainer(event.payload.label, event.payload.container),
          { target: ownLabel },
        ),
      ]);
      if (stop) {
        fns.forEach((fn) => fn());
        return;
      }
      unlist.push(...fns);
    })();
    return () => {
      stop = true;
      unlist.forEach((fn) => fn());
    };
  }, []);

  // A context window says who it is, so the rail can mark it and the menu can
  // focus it instead of opening a second window for the same cluster.
  useEffect(() => {
    if (pinned == null) return;
    void emit("ctx-window", { label: ownLabel, context: pinned }).catch(() => undefined);
  }, [pinned, ownLabel]);

  // The rail marks the contexts with a window of their own. Windows announce
  // themselves; a window that closed without this one hearing it is pruned by
  // asking the shell which labels still exist.
  useEffect(() => {
    if (pinned != null) return;
    let stop = false;
    void WebviewWindow.getAll()
      .then((all) => {
        if (stop) return;
        const labels = new Set(all.map((win) => win.label));
        for (const label of [...ctxWindowNames.current.keys()]) {
          if (!labels.has(label)) ctxWindowNames.current.delete(label);
        }
        syncContextWindows();
      })
      .catch(() => undefined);
    const unlisten = listen<{ label: string; context: string }>("ctx-window", (event) => {
      const { label, context } = event.payload;
      if (!label.startsWith("ctx-")) return;
      ctxWindowNames.current.set(label, context);
      syncContextWindows();
    });
    return () => {
      stop = true;
      void unlisten.then((fn) => fn());
    };
  }, [pinned]);

  useEffect(() => {
    if (active != null || !context) return;
    const id = window.setInterval(() => {
      void send({ fetchOverview: { context } });
    }, 15000);
    return () => window.clearInterval(id);
  }, [active, context]);

  // The settings load once and again whenever another window of this process
  // saves them: every window applies the same files, so nothing changes under
  // one window's back.
  useEffect(() => {
    let stop = false;
    function applyStored() {
      void Promise.all([readSettingsFile(), readThemesFile()])
        .then(([settings, stored]) => {
          if (stop) return;
          const prefs = parsePrefs(settings);
          setKeymap(prefs.keymap);
          setTheme(prefs.theme);
          setActiveTheme(prefs.themeName);
          setColors(prefs.colors);
          // Every strip and badge reads the color through this map, so it has to
          // be in place before the first render that shows one.
          setClusterColors(prefs.colors);
          // Shipped themes come from code; the file holds only custom ones.
          setThemes([...BUILTIN_THEMES, ...parseThemes(stored)]);
        })
        .catch(() => {
          if (!stop) pushError("Settings could not be read");
        });
    }
    const unlisten = listen("prefs-saved", applyStored);
    applyStored();
    return () => {
      stop = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  // The whole UI re-themes from CSS custom properties.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function persist(
    nextKeymap: Keymap,
    nextTheme: Theme,
    nextThemeName: string | null,
    nextColors: Record<string, string>,
  ) {
    void writeSettingsFile(
      serializePrefs({
        keymap: nextKeymap,
        theme: nextTheme,
        themeName: nextThemeName,
        colors: nextColors,
      }),
    )
      .then(() => {
        // The other windows of this process hold their own copy of the
        // settings; they re-read the file when it changes under them.
        void emit("prefs-saved").catch(() => undefined);
      })
      .catch(() => pushError("Settings could not be saved"));
  }

  /** Writes the custom themes; the shipped ones never go into the file. */
  function persistThemes(next: NamedTheme[]) {
    setThemes(next);
    void writeThemesFile(serializeThemes(next))
      .then(() => {
        void emit("prefs-saved").catch(() => undefined);
      })
      .catch(() => pushError("Themes could not be saved"));
  }

  /** Applies a change immediately, keeping the running state even if the write fails. */
  function commitKeymap(next: Keymap) {
    setKeymap(next);
    persist(next, theme, activeTheme, colors);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // While settings is open its recorder owns the keyboard.
      if (settingsOpen) return;
      const node = event.target as HTMLElement | null;
      const typing =
        node != null &&
        (node.isContentEditable ||
          node.tagName === "INPUT" ||
          node.tagName === "TEXTAREA" ||
          node.tagName === "SELECT");
      if (!searchOpen && matchesBinding(event, keymap.openSearch)) {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (matchesBinding(event, keymap.openSettings)) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      // A modified binding is safe anywhere; a bare key would eat typing.
      const filter = keymap.focusFilter;
      if (matchesBinding(event, filter) && (typing ? !isTypedKey(filter) : true)) {
        event.preventDefault();
        focusFilter.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, settingsOpen, keymap]);

  const activeTab = active == null ? null : (tabs[active] ?? null);
  const activeNamespace = activeTab?.namespace ?? null;
  // Everything the window shows belongs to the context it is browsing; tabs of
  // other clusters keep their own state until they are focused again.
  const scopeKey = `${context ?? ""}|${activeNamespace ?? ""}`;
  const scopeWarnings = warnings.scope === scopeKey ? warnings.byUid : null;

  useEffect(() => {
    if (active == null || !context) return;
    requestWarnings(true);
    const id = window.setInterval(() => requestWarnings(true), WARNINGS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [active, context, activeNamespace]);

  return {
    contexts,
    context,
    namespaces: namespaces[context ?? ""] ?? [],
    /** True once tabs from more than one cluster are open. */
    clustered: new Set(tabs.map((tab) => tab.context)).size > 1,
    tabs,
    active,
    activeTab,
    home,
    customResources: customResources[context ?? ""] ?? [],
    errors,
    refreshing,
    loadingConfig,
    connecting,
    overview: overview[context ?? ""] ?? null,
    metricsNote,
    history,
    searchOpen,
    createOpen,
    createYaml,
    createError,
    createBusy,
    pendingDelete,
    now,
    dockTabs,
    activeDock,
    menu,
    dismissError: (index: number) => {
      setErrors((current) => current.filter((_, item) => item !== index));
    },
    switchContext,
    openKubeconfig: async () => {
      const picked = await open({ title: "Open kubeconfig", multiple: false, directory: false });
      if (typeof picked !== "string") return;
      haltPane("log");
      haltForwards();
      haltPane("exec");
      session.current.context = null;
      setContext(null);
      setConnected([]);
      setLoadingConfig(true);
      void send({ setKubeconfig: { path: picked } });
    },
    openView,
    /** Focus an open tab: the window follows the cluster it belongs to. */
    focusTab: (index: number) => activate(index),
    closeTab: (index: number) => {
      const closing = session.current.tabs[index];
      const next = session.current.tabs.filter((_, i) => i !== index);
      const current = session.current.active;
      commitTabs(next);
      // The last tab of a cluster ends its watch; other clusters keep theirs.
      if (closing && !next.some((tab) => tab.context === closing.context)) {
        void send({ stopWatch: { context: closing.context } });
      }
      if (current == null) return;
      if (current > index) {
        session.current.active = current - 1;
        setActive(current - 1);
      } else if (current === index) {
        if (next.length === 0) {
          session.current.active = null;
          setActive(null);
          if (session.current.context) {
            void send({ fetchOverview: { context: session.current.context } });
          }
        } else {
          activate(Math.min(index, next.length - 1));
        }
      }
    },
    setNamespace: (namespace: string | null) => {
      const index = session.current.active;
      if (index == null) return;
      applyNamespace(index, namespace);
    },
    setFilter: (filter: string) => {
      const index = session.current.active;
      if (index == null) return;
      updateTabs((items) => items.map((item, i) => (i === index ? { ...item, filter } : item)));
    },
    toggleSort: (sortKey: string) => {
      const index = session.current.active;
      if (index == null) return;
      updateTabs((items) =>
        items.map((item, i) => {
          if (i !== index) return item;
          if (item.sortKey === sortKey) return { ...item, sortAsc: !item.sortAsc };
          return { ...item, sortKey, sortAsc: true };
        }),
      );
    },
    selectRow: (uid: string, shift: boolean, order: string[]) => {
      const index = session.current.active;
      if (index == null) return;
      const tab = session.current.tabs[index];
      if (!tab) return;
      const anchor = tab.anchor;
      if (shift && anchor && order.includes(anchor) && order.includes(uid)) {
        const from = order.indexOf(anchor);
        const to = order.indexOf(uid);
        const start = Math.min(from, to);
        const end = Math.max(from, to);
        focusRow(index, uid, order.slice(start, end + 1), anchor);
        return;
      }
      focusRow(index, uid, [uid], uid);
    },
    clearSelection: () => {
      const index = session.current.active;
      if (index == null) return;
      updateTabs((items) =>
        items.map((item, i) => (i === index ? { ...item, selected: null, selection: [], anchor: null } : item)),
      );
    },
    setDetailTab: showDetail,
    openLogs: () => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      const row = tab?.rows.find((item) => item.uid === tab.selected);
      if (!tab || tab.view.kind !== "resource" || !row || !canLogs(tab.view.resource)) return;
      openResourceLogs(tab.view.resource, row.namespace, row.name);
    },
    selectDock: (label: string) => setActiveDock(label),
    closeDock: (label: string) => {
      const tab = findDock(label);
      if (tab) stopDock(tab);
    },
    reorderTabs,
    reorderDock,
    detachDock,
    setLogPod: (pod: string) => {
      const current = findDock(activeDockRef.current ?? "");
      if (!current || current.pane !== "log" || current.detached || pod === "" || pod === current.pod) return;
      replaceLog(current, pod, null);
    },
    setLogContainer: (container: string) => {
      const current = findDock(activeDockRef.current ?? "");
      if (!current || current.pane !== "log" || current.detached || container === current.container) return;
      replaceLog(current, current.pod || null, container);
    },
    setLogPrevious: (previous: boolean) => {
      const current = findDock(activeDockRef.current ?? "");
      if (!current || current.pane !== "log" || current.detached || previous === current.previous) return;
      flagLog(current, { previous });
    },
    setLogTimestamps: (timestamps: boolean) => {
      const current = findDock(activeDockRef.current ?? "");
      if (!current || current.pane !== "log" || current.detached || timestamps === current.timestamps) return;
      flagLog(current, { timestamps });
    },
    openMenu: (x: number, y: number, uid: string) => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      if (index != null && tab && !tab.selection.includes(uid)) focusRow(index, uid, [uid], uid);
      setCtxMenu(null);
      setMenu({ x, y, uid });
    },
    closeMenu: () => setMenu(null),
    ctxMenu,
    /** Contexts this window holds a connection to, in the order they connected. */
    connectedContexts: connected,
    /** Context colors picked by hand, keyed by context name. */
    clusterColors: colors,
    openContextMenu: (x: number, y: number, name: string) => {
      setMenu(null);
      setCtxMenu({ x, y, name });
    },
    closeContextMenu: () => setCtxMenu(null),
    /** Drops one cluster; the window closes its tabs when the engine confirms. */
    disconnectContext: (name: string) => {
      setCtxMenu(null);
      void send({ disconnect: { context: name } });
    },
    /** The context this window is pinned to, or null in the main window. */
    pinned,
    /** True in a context window with nothing to browse: its context left the kubeconfig, or it is not connected. */
    pinnedMissing:
      pinned != null &&
      (pinnedGone || (!loadingConfig && !connecting && !connected.includes(pinned))),
    /** True in a context window whose context left the kubeconfig. */
    pinnedGone,
    /** Contexts with a window of their own open. */
    contextWindows,
    /** Opens a context in its own window, or focuses the window it already has. */
    openContextWindow,
    /** Connects one context outright: a context window's splash has no rail to click. */
    connectContext: (name: string) => {
      setConnecting(true);
      void send({ connect: { context: name } });
    },
    /** Closes this window: the splash of a context that left the kubeconfig. */
    closeWindow: () => {
      void getCurrentWindow().close().catch(() => undefined);
    },
    /** Picks a color for a context, or `null` to go back to the hue of its name. */
    setClusterColor: (name: string, color: string | null) => {
      const next = { ...colors };
      if (color == null) delete next[name];
      else next[name] = color;
      // Plain helpers read this map too, so it changes before the re-render.
      setClusterColors(next);
      setColors(next);
      persist(keymap, theme, activeTheme, next);
    },
    setReveal: (reveal: boolean) => {
      const index = session.current.active;
      if (index == null) return;
      updateTabs((items) =>
        items.map((item, i) =>
          i === index ? { ...item, reveal, yaml: null, yamlFor: null, data: null, dataFor: null } : item,
        ),
      );
      requestYaml(index);
      if (session.current.tabs[index]?.detailTab === "sources") requestSources(index);
      if (session.current.tabs[index]?.detailTab === "overview") requestPodContainers(index);
    },
    refresh: () => {
      if (refreshingRef.current) return;
      beginRefresh();
      const current = session.current.context;
      if (!current) return;
      void send({ refreshCatalog: { context: current } });
      const index = session.current.active;
      if (index == null) void send({ fetchOverview: { context: current } });
      else activate(index);
    },
    askDelete: () => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      const target = tab ? watchOf(tab.view) : null;
      const rows = tab ? selectedRows(tab) : [];
      if (!tab || !target || rows.length === 0) return;
      setPendingDelete({
        title: viewTitle(tab.view),
        target,
        items: rows.map((row) => ({ namespace: row.namespace, name: row.name })),
      });
    },
    confirmDelete: () => {
      if (!pendingDelete) return;
      for (const item of pendingDelete.items) {
        void send({
          delete: {
            context: session.current.context ?? "",
            target: pendingDelete.target,
            namespace: item.namespace,
            name: item.name,
          },
        });
      }
      setPendingDelete(null);
    },
    cancelDelete: () => setPendingDelete(null),
    restartSelected: () => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      if (!tab || tab.view.kind !== "resource" || !canRestart(tab.view.resource)) return;
      for (const row of selectedRows(tab)) {
        void send({
          restart: {
            context: tab.context,
            kind: tab.view.resource,
            namespace: row.namespace,
            name: row.name,
          },
        });
      }
    },
    openCreate: () => {
      setCreateError(null);
      setCreateBusy(false);
      setCreateOpen(true);
    },
    setCreateYaml,
    closeCreate: () => {
      if (createBusy) return;
      setCreateOpen(false);
    },
    applyCreate: () => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      applyKind.current = "create";
      applyContext.current = tab?.context ?? "";
      setCreateBusy(true);
      setCreateError(null);
      void send({ apply: { context: tab?.context ?? "", yaml: createYaml, namespace: tab?.namespace ?? null } });
    },
    patchError,
    patchYaml: (yaml: string) => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      applyKind.current = "patch";
      applyContext.current = tab?.context ?? "";
      setPatchError(null);
      void send({ apply: { context: tab?.context ?? "", yaml, namespace: tab?.namespace ?? null } });
    },
    forwards,
    forwardDraft,
    askForward: () => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      const row = tab?.rows.find((item) => item.uid === tab.selected);
      if (!tab || tab.view.kind !== "resource" || !row || !canForward(tab.view.resource)) return;
      setForwardDraft({
        namespace: row.namespace,
        name: row.name,
        kind: tab.view.resource,
        localPort: "",
        remotePort: "",
      });
    },
    setForwardPort: (field: "localPort" | "remotePort", value: string) => {
      setForwardDraft((current) => (current ? { ...current, [field]: value.replace(/[^\d]/g, "") } : current));
    },
    cancelForward: () => setForwardDraft(null),
    confirmForward: () => {
      const draft = forwardDraft;
      if (!draft) return;
      const localPort = Number(draft.localPort);
      const remotePort = Number(draft.remotePort);
      if (
        !Number.isInteger(localPort) ||
        !Number.isInteger(remotePort) ||
        localPort < 1 ||
        localPort > 65535 ||
        remotePort < 1 ||
        remotePort > 65535
      ) {
        pushError("Port must be between 1 and 65535");
        return;
      }
      setForwardDraft(null);
      startForward({
        namespace: draft.namespace,
        name: draft.name,
        kind: draft.kind,
        localPort,
        remotePort,
      });
    },
    forwardServicePort: (namespace: string, name: string, port: number) => {
      if (
        forwardsRef.current.some(
          (item) => item.namespace === namespace && item.name === name && item.remotePort === port,
        )
      ) {
        return;
      }
      startForward({ namespace, name, kind: "services", localPort: port, remotePort: port });
    },
    stopForward: (id: number) => {
      void send({ stopPortForward: { id } });
    },
    openExec: () => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      const row = tab?.rows.find((item) => item.uid === tab.selected);
      if (!tab || tab.view.kind !== "resource" || !row || !canExec(tab.view.resource)) return;
      openPodExec(row.namespace, row.name);
    },
    setExecContainer: (container: string) => {
      const label = activeDockRef.current;
      if (label) setExecContainer(label, container);
    },
    execInput: (data: string) => {
      const label = activeDockRef.current;
      if (label) execInputLabel(label, data);
    },
    execResize: (cols: number, rows: number) => {
      const label = activeDockRef.current;
      if (label) execResizeLabel(label, cols, rows);
    },
    bindExec: (label: string, write: ((text: string) => void) | null) => {
      if (write) execWrites.current.set(label, write);
      else execWrites.current.delete(label);
    },
    readExecText: (label: string) => {
      const tab = findDock(label);
      return tab?.pane === "exec" ? tab.text : "";
    },
    setSearchOpen,
    settingsOpen,
    setSettingsOpen,
    keymap,
    setBinding: (action: KeymapAction, next: Binding) => {
      commitKeymap({ ...keymap, [action]: next });
    },
    resetBinding: (action: KeymapAction) => {
      commitKeymap({ ...keymap, [action]: DEFAULT_KEYMAP[action] });
    },
    resetKeymap: () => commitKeymap(DEFAULT_KEYMAP),
    theme,
    /** Every theme on offer, shipped ones first. */
    themes,
    /** Id of the active theme, or null when the colors were edited by hand. */
    activeTheme,
    /** What the last theme action did or refused; shown under the theme list. */
    themeNote,
    /** Switch theme: base, mode, accent and status colors all change together. */
    selectTheme: (id: string) => {
      const named = themes.find((item) => item.id === id);
      if (!named) return;
      setTheme(named.theme);
      setActiveTheme(named.id);
      persist(keymap, named.theme, named.id, colors);
    },
    /** Reads a theme file the user picked, validates it, and adds what it holds. */
    loadThemeFromFile: async () => {
      const picked = await open({
        title: "Load a color theme",
        multiple: false,
        directory: false,
        filters: [{ name: "Color theme", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      let text: string;
      try {
        text = await readThemeFile(picked);
      } catch (err) {
        setThemeNote({ kind: "bad", text: err instanceof Error ? err.message : String(err) });
        return;
      }
      const parsed = parseThemeFile(text);
      if (!parsed.ok) {
        setThemeNote({ kind: "bad", text: parsed.error });
        return;
      }
      // A name the list already holds is replaced, and the note below says so.
      const replaced = parsed.themes.filter((incoming) =>
        themes.some((item) => !item.builtin && item.label.toLowerCase() === incoming.label.toLowerCase()),
      );
      const replacedIds = new Set(replaced.map((item) => item.id));
      const kept = themes.filter(
        (item) => item.builtin || !parsed.themes.some((incoming) => incoming.label.toLowerCase() === item.label.toLowerCase()),
      );
      // Ids stay unique: a different name can slug to an id the list already
      // holds, so a collision gets a suffix rather than a shadowed theme.
      const taken = new Set(themes.filter((item) => !replacedIds.has(item.id)).map((item) => item.id));
      const loaded = parsed.themes.map((incoming) => {
        let id = incoming.id;
        for (let n = 2; taken.has(id); n += 1) id = `${incoming.id}-${n}`;
        taken.add(id);
        return { ...incoming, id };
      });
      persistThemes([...kept, ...loaded]);
      // A replaced theme keeps its id; when it was the active one, the window
      // follows its new colors instead of showing a stale palette.
      const replacement = loaded.find((incoming) => incoming.id === activeTheme);
      if (replacement) {
        setTheme(replacement.theme);
        persist(keymap, replacement.theme, replacement.id, colors);
      }
      setThemeNote({
        kind: "ok",
        text:
          loaded.length === 1
            ? replaced.length > 0
              ? `Theme "${loaded[0]?.label}" was replaced.`
              : `Theme "${loaded[0]?.label}" was added.`
            : `${loaded.length} themes loaded${replaced.length > 0 ? `, ${replaced.length} replaced` : ""}.`,
      });
    },
    /** Names the colors on screen as a theme; the same name overwrites that one. */
    saveTheme: (name: string) => {
      const label = name.trim();
      if (label === "") return;
      const existing = themes.find((item) => !item.builtin && item.label.toLowerCase() === label.toLowerCase());
      if (existing) {
        persistThemes(themes.map((item) => (item.id === existing.id ? { ...item, theme } : item)));
        setActiveTheme(existing.id);
        persist(keymap, theme, existing.id, colors);
        return;
      }
      const named: NamedTheme = {
        id: uniqueThemeId(label, themes.map((item) => item.id)),
        label,
        builtin: false,
        theme,
      };
      persistThemes([...themes, named]);
      setActiveTheme(named.id);
      persist(keymap, theme, named.id, colors);
    },
    /** Removes a custom theme; the colors it had stay on screen until another change. */
    deleteTheme: (id: string) => {
      const named = themes.find((item) => item.id === id);
      if (named == null || named.builtin) return;
      persistThemes(themes.filter((item) => item.id !== id));
      if (activeTheme === id) {
        setActiveTheme(null);
        persist(keymap, theme, null, colors);
      }
    },
    updateTheme: (patch: Partial<Theme>) => {
      const next = { ...theme, ...patch };
      setTheme(next);
      // Colors picked by hand are no longer any named theme's colors.
      setActiveTheme(null);
      persist(keymap, next, null, colors);
    },
    resetTheme: () => {
      setTheme(DEFAULT_THEME);
      setActiveTheme(DEFAULT_THEME_ID);
      persist(keymap, DEFAULT_THEME, DEFAULT_THEME_ID, colors);
    },
    bindFilter: (focus: (() => void) | null) => {
      focusFilter.current = focus;
    },
    /** Warning marker for a row, hiding probe noise from a pod that is up again. */
    warning: (row: ResourceRow) => {
      const item = scopeWarnings?.[row.uid];
      if (item == null) return null;
      const pods = activeTab?.view.kind === "resource" && activeTab.view.resource === "pods";
      if (pods && item.probeOnly && podSettled(row)) return null;
      return item;
    },
    openNamed: (target: CrTarget, namespace: string, name: string) => {
      const watch: WatchTarget = { custom: target };
      session.current.pending = { target: watch, namespace, name };
      openView({ kind: "custom", target });
      selectPending();
    },
  };
}

export type Kubi = ReturnType<typeof useKubi>;
