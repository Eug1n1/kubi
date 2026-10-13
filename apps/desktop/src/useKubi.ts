import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { readSettingsFile, send, writeSettingsFile } from "./api";
import {
  DEFAULT_KEYMAP,
  isTypedKey,
  matchesBinding,
  type Binding,
  type Keymap,
  type KeymapAction,
} from "./keymap";
import { parsePrefs, serializePrefs } from "./prefs";
import { DEFAULT_THEME, applyTheme, type Theme } from "./theme";
import type {
  AppEvent,
  ClusterOverview,
  ContextInfo,
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
import { eventKey, sameTarget, sameView, watchOf } from "./types";
import { canExec, canForward, canLogs, canRestart, logTitle, podSettled, viewTitle } from "./catalog";

type HistPoint = { t: number; cpu: number; mem: number };

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
  usage: Record<string, [number, number]>;
  defaultNamespace: string | null;
  lastNamespace: string | null;
  nextId: number;
  started: number;
};

function blankTab(view: View, namespace: string | null, id: number): Tab {
  return {
    id,
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

function applyUsage(rows: ResourceRow[], usage: Record<string, [number, number]>): ResourceRow[] {
  return rows.map((row) => {
    const sample = usage[`${row.namespace}/${row.name}`];
    if (!sample) return row;
    return { ...row, cpuMillis: sample[0], memBytes: sample[1] };
  });
}

export function useKubi() {
  const session = useRef<Session>({
    context: null,
    active: null,
    tabs: [],
    home: "cluster",
    pending: null,
    usage: {},
    defaultNamespace: null,
    lastNamespace: null,
    nextId: 1,
    started: performance.now(),
  });
  const [contexts, setContexts] = useState<ContextInfo[]>([]);
  const [context, setContext] = useState<string | null>(null);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [home, setHome] = useState<Home>("cluster");
  const [customResources, setCustomResources] = useState<CrTarget[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refreshStarted = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [metricsNote, setMetricsNote] = useState<string | null>(null);
  const [history, setHistory] = useState<HistPoint[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keymap, setKeymap] = useState<Keymap>(DEFAULT_KEYMAP);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
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
  const logSeq = useRef(0);
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
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [forwardDraft, setForwardDraft] = useState<ForwardDraft | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const forwardsRef = useRef<PortForward[]>([]);
  const forwardSeq = useRef(0);
  const execSeq = useRef(0);
  const applyKind = useRef<"create" | "patch">("create");

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
    void send({ startLogs: { id, kind, namespace, name, pod, container, previous, timestamps } });
    return {
      pane: "log",
      id,
      label: prior?.label ?? `log-${id}`,
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
      if (existing.detached) void focusDockWindow(existing.label);
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
      void focusDockWindow(tab.label);
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
    void send({ startExec: { id, namespace, name, container } });
    return {
      pane: "exec",
      id,
      label: previous?.label ?? `exec-${id}`,
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
      if (existing.detached) void focusDockWindow(existing.label);
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
      void focusDockWindow(tab.label);
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

  function focusDockWindow(label: string) {
    void WebviewWindow.getByLabel(label)
      .then((win) => win?.setFocus())
      .catch(() => undefined);
  }

  function dockTitle(tab: DockTab): string {
    if (tab.pane === "log") return logTitle(tab.kind, tab.namespace, tab.name);
    return tab.namespace ? `Exec ${tab.namespace}/${tab.name}` : `Exec ${tab.name}`;
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
  }

  function commitTabs(next: Tab[]) {
    session.current.tabs = next;
    setTabs(next);
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
    if (current.tabs.length === 0) return current.defaultNamespace;
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
    void send({ fetchEvents: { namespace: row.namespace, name: row.name, uid: row.uid } });
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
    void send({ fetchWarnings: { namespace: tab.namespace } });
  }

  function activate(index: number) {
    const tab = session.current.tabs[index];
    if (!tab) return;
    session.current.active = index;
    setActive(index);
    const target = watchOf(tab.view);
    if (!target) return;
    updateTabs((items) => items.map((item, i) => (i === index ? { ...item, waiting: true } : item)));
    void send({ setNamespace: { namespace: tab.namespace } });
    void send({ watch: { target } });
    if (tab.detailTab === "events") requestEvents(index);
  }

  function showHome(next: Home) {
    if (session.current.active == null && session.current.home === next) return;
    session.current.home = next;
    session.current.active = null;
    setHome(next);
    setActive(null);
    void send("stopWatch");
    void send("fetchOverview");
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
              waiting: true,
            }
          : item,
      ),
    );
    session.current.usage = {};
    setHistory([]);
    const target = watchOf(session.current.tabs[index]?.view ?? tab.view);
    void send({ setNamespace: { namespace } });
    if (target) void send({ watch: { target } });
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
    const existing = session.current.tabs.findIndex((tab) => sameView(tab.view, view));
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
    const tab = blankTab(view, namespace === undefined ? inherited() : namespace, session.current.nextId);
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
        id,
        namespace: draft.namespace,
        name: draft.name,
        kind: draft.kind,
        localPort: draft.localPort,
        remotePort: draft.remotePort,
      },
    });
  }

  function switchContext(name: string) {
    if (session.current.context === name) return;
    session.current.context = name;
    session.current.defaultNamespace = null;
    session.current.lastNamespace = null;
    session.current.tabs = [];
    session.current.active = null;
    session.current.home = "cluster";
    session.current.pending = null;
    session.current.usage = {};
    setContext(name);
    setNamespaces([]);
    setCustomResources([]);
    setTabs([]);
    setActive(null);
    setHome("cluster");
    setPendingDelete(null);
    setMenu(null);
    haltPane("log");
    haltForwards();
    haltPane("exec");
    setCreateOpen(false);
    setCreateError(null);
    setCreateBusy(false);
    setSearchOpen(false);
    setOverview(null);
    setHistory([]);
    setMetricsNote(null);
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
    const key = eventKey(event);
    if (key === "contexts" && "contexts" in event) {
      setLoadingConfig(false);
      clearErrors();
      setContexts(event.contexts);
      if (event.contexts.length === 0) {
        setConnecting(false);
        setCustomResources([]);
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
      if (session.current.context !== event.connected.context) return;
      setNamespaces(event.connected.namespaces);
      session.current.defaultNamespace = event.connected.defaultNamespace;
      setConnecting(false);
      clearErrors();
      void send("fetchOverview");
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
      setCustomResources(event.customResources.targets);
      return;
    }
    if (key === "rows" && "rows" in event) {
      const { target, rows } = event.rows;
      const withUsage = applyUsage(rows, session.current.usage);
      const observedAt = Date.now();
      const live = new Set(withUsage.map((row) => row.uid));
      const refreshYaml: number[] = [];
      updateTabs((items) =>
        items.map((tab, index) => {
          const watching = watchOf(tab.view);
          if (!watching || !sameTarget(watching, target)) return tab;
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
      for (const sample of event.usage.samples) {
        session.current.usage[`${sample.namespace}/${sample.name}`] = [sample.cpuMillis, sample.memBytes];
      }
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      if (tab?.view.kind === "resource" && tab.view.resource === event.usage.kind) {
        updateTabs((items) =>
          items.map((item, i) => (i === index ? { ...item, rows: applyUsage(item.rows, session.current.usage) } : item)),
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
      if (tab?.view.kind === "resource" && tab.view.resource === event.metricsUnavailable.kind) {
        setMetricsNote(event.metricsUnavailable.message);
      }
      return;
    }
    if (key === "yaml" && "yaml" in event) {
      updateTabs((items) =>
        items.map((tab) =>
          tab.selected === event.yaml.uid ? { ...tab, yaml: event.yaml.yaml, yamlFor: event.yaml.uid } : tab,
        ),
      );
      return;
    }
    if (key === "objectData" && "objectData" in event) {
      updateTabs((items) =>
        items.map((tab) =>
          tab.selected === event.objectData.uid
            ? { ...tab, data: event.objectData.entries, dataFor: event.objectData.uid }
            : tab,
        ),
      );
      return;
    }
    if (key === "objectEvents" && "objectEvents" in event) {
      const { uid, events } = event.objectEvents;
      updateTabs((items) =>
        items.map((tab) => (tab.eventsFor === uid ? { ...tab, events } : tab)),
      );
      return;
    }
    if (key === "warnings" && "warnings" in event) {
      const byUid: Record<string, ObjectWarning> = {};
      for (const item of event.warnings.objects) byUid[item.uid] = item;
      setWarnings({ scope: event.warnings.namespace, byUid });
      return;
    }
    if (key === "applyResult" && "applyResult" in event) {
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
        if (target) {
          void send({ setNamespace: { namespace: tab?.namespace ?? null } });
          void send({ watch: { target } });
        }
      }
      return;
    }
    if (key === "overview" && "overview" in event) {
      setOverview(event.overview);
      if (session.current.active == null) endRefresh();
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
      const fns = await Promise.all([
        listen<{ label: string }>("log-ready", (event) => dockActions.current.ready(event.payload.label), {
          target: "main",
        }),
        listen<{ label: string }>("log-dock", (event) => dockActions.current.dock(event.payload.label), {
          target: "main",
        }),
        listen<{ label: string }>("log-close", (event) => dockActions.current.close(event.payload.label), {
          target: "main",
        }),
        listen<{ label: string; pod: string }>(
          "log-pod",
          (event) => dockActions.current.pod(event.payload.label, event.payload.pod),
          { target: "main" },
        ),
        listen<{ label: string; container: string }>(
          "log-container",
          (event) => dockActions.current.container(event.payload.label, event.payload.container),
          { target: "main" },
        ),
        listen<{ label: string; value: boolean }>(
          "log-previous",
          (event) => dockActions.current.previous(event.payload.label, event.payload.value),
          { target: "main" },
        ),
        listen<{ label: string; value: boolean }>(
          "log-timestamps",
          (event) => dockActions.current.timestamps(event.payload.label, event.payload.value),
          { target: "main" },
        ),
        listen<{ label: string }>("exec-ready", (event) => dockActions.current.ready(event.payload.label), {
          target: "main",
        }),
        listen<{ label: string }>("exec-close", (event) => dockActions.current.close(event.payload.label), {
          target: "main",
        }),
        listen<{ label: string; data: string }>(
          "exec-input",
          (event) => dockActions.current.input(event.payload.label, event.payload.data),
          { target: "main" },
        ),
        listen<{ label: string; cols: number; rows: number }>(
          "exec-resize",
          (event) => dockActions.current.resize(event.payload.label, event.payload.cols, event.payload.rows),
          { target: "main" },
        ),
        listen<{ label: string; container: string }>(
          "exec-container",
          (event) => dockActions.current.execContainer(event.payload.label, event.payload.container),
          { target: "main" },
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

  useEffect(() => {
    if (active != null || !context) return;
    const id = window.setInterval(() => {
      void send("fetchOverview");
    }, 15000);
    return () => window.clearInterval(id);
  }, [active, context]);

  useEffect(() => {
    let stop = false;
    void readSettingsFile()
      .then((text) => {
        if (stop) return;
        const prefs = parsePrefs(text);
        setKeymap(prefs.keymap);
        setTheme(prefs.theme);
      })
      .catch(() => {
        if (!stop) pushError("Settings could not be read");
      });
    return () => {
      stop = true;
    };
  }, []);

  // The whole UI re-themes from CSS custom properties.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function persist(nextKeymap: Keymap, nextTheme: Theme) {
    void writeSettingsFile(serializePrefs({ keymap: nextKeymap, theme: nextTheme })).catch(() =>
      pushError("Settings could not be saved"),
    );
  }

  /** Applies a change immediately, keeping the running state even if the write fails. */
  function commitKeymap(next: Keymap) {
    setKeymap(next);
    persist(next, theme);
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
  const scopeWarnings = warnings.scope === activeNamespace ? warnings.byUid : null;

  useEffect(() => {
    if (active == null || !context) return;
    requestWarnings(true);
    const id = window.setInterval(() => requestWarnings(true), WARNINGS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [active, context, activeNamespace]);

  return {
    contexts,
    context,
    namespaces,
    tabs,
    active,
    activeTab,
    home,
    customResources,
    errors,
    refreshing,
    loadingConfig,
    connecting,
    overview,
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
      setLoadingConfig(true);
      void send({ setKubeconfig: { path: picked } });
    },
    openView,
    closeTab: (index: number) => {
      const next = session.current.tabs.filter((_, i) => i !== index);
      const current = session.current.active;
      commitTabs(next);
      if (current == null) return;
      if (current > index) {
        session.current.active = current - 1;
        setActive(current - 1);
      }         else if (current === index) {
        if (next.length === 0) {
          session.current.active = null;
          setActive(null);
          void send("stopWatch");
          void send("fetchOverview");
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
      setMenu({ x, y, uid });
    },
    closeMenu: () => setMenu(null),
    setReveal: (reveal: boolean) => {
      const index = session.current.active;
      if (index == null) return;
      updateTabs((items) =>
        items.map((item, i) =>
          i === index ? { ...item, reveal, yaml: null, yamlFor: null, data: null, dataFor: null } : item,
        ),
      );
      requestYaml(index);
    },
    refresh: () => {
      if (refreshingRef.current) return;
      beginRefresh();
      void send("refreshCatalog");
      if (session.current.active == null) void send("fetchOverview");
      else activate(session.current.active);
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
        void send({ restart: { kind: tab.view.resource, namespace: row.namespace, name: row.name } });
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
      setCreateBusy(true);
      setCreateError(null);
      void send({ apply: { yaml: createYaml, namespace: tab?.namespace ?? null } });
    },
    patchError,
    patchYaml: (yaml: string) => {
      const index = session.current.active;
      const tab = index == null ? undefined : session.current.tabs[index];
      applyKind.current = "patch";
      setPatchError(null);
      void send({ apply: { yaml, namespace: tab?.namespace ?? null } });
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
    updateTheme: (patch: Partial<Theme>) => {
      const next = { ...theme, ...patch };
      setTheme(next);
      persist(keymap, next);
    },
    resetTheme: () => {
      setTheme(DEFAULT_THEME);
      persist(keymap, DEFAULT_THEME);
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
