import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Kubi } from "./useKubi";
import type { ArgoApp, CrTarget, DataEntry, EventInfo, ObjectWarning, PodContainer, PodEnv, PodMount, PodSources, ResourceKind, ResourceRow, View } from "./types";
import { bindingKeys } from "./keymap";
import {
  NAV,
  TITLES,
  argoInstalled,
  canExec,
  canForward,
  canLogs,
  canRestart,
  completeSearch,
  canSources,
  crGroups,
  hasValues,
  installedGateway,
  isSecret,
  logTitle,
  namespaceSuggestions,
  planSearch,
  searchHits,
  supportsMetrics,
  viewAcceptsNamespace,
  viewTitle,
  visibleEvents,
  type SearchHit,
} from "./catalog";
import { columnKey, columnsFor, compareRows, fieldText, isNumericField, type Field } from "./columns";
import { YamlEditor } from "./yamlEditor";
import { clusterColor, formatAge, formatBytes, formatBytesPair, formatCpu, formatCpuPair, liveAge, previewValue } from "./format";
import { objectTemplate } from "./templates";
import { ExecPane } from "./execWindow";
import { LogPane } from "./logWindow";

type DragSlot = { index: number; mid: number; width: number };

type DragLive = {
  token: string;
  dx: number;
  dy: number;
  from: number;
  over: number | null;
  width: number;
  left: number;
  top: number;
  height: number;
};

function readSlots(root: HTMLElement, attr: string): DragSlot[] {
  return [...root.querySelectorAll<HTMLElement>(`[${attr}]`)].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      index: Number(el.getAttribute(attr)),
      mid: rect.left + rect.width / 2,
      width: rect.width,
    };
  });
}

function useTabDrag() {
  const drag = useRef<{
    token: string;
    x: number;
    y: number;
    from: number;
    width: number;
    left: number;
    top: number;
    height: number;
    moved: boolean;
    over: number | null;
    dx: number;
    dy: number;
    slots: DragSlot[];
  } | null>(null);
  const [live, setLive] = useState<DragLive | null>(null);
  const skipClick = useRef(false);
  return {
    live,
    down(token: string, from: number, event: ReactPointerEvent, root: HTMLElement, attr: string) {
      if (event.button !== 0) return;
      const slots = readSlots(root, attr);
      const host = event.currentTarget.closest("[data-tab-index], [data-dock-index]");
      const rect = host instanceof HTMLElement ? host.getBoundingClientRect() : null;
      const width = rect?.width ?? slots.find((slot) => slot.index === from)?.width ?? 0;
      skipClick.current = false;
      drag.current = {
        token,
        x: event.clientX,
        y: event.clientY,
        from,
        width,
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        height: rect?.height ?? 0,
        moved: false,
        over: from,
        dx: 0,
        dy: 0,
        slots,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    move(event: ReactPointerEvent, inside: boolean) {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      const moved = state.moved || Math.hypot(dx, dy) > 4;
      state.dx = dx;
      state.dy = dy;
      state.moved = moved;
      if (!moved) return;
      let over: number | null = null;
      if (inside && state.slots.length > 0) {
        over = state.slots[0]?.index ?? null;
        for (const slot of state.slots) {
          if (event.clientX >= slot.mid) over = slot.index;
        }
      }
      state.over = over;
      setLive({
        token: state.token,
        dx,
        dy,
        from: state.from,
        over,
        width: state.width,
        left: state.left,
        top: state.top,
        height: state.height,
      });
    },
    up(): DragLive | null {
      const state = drag.current;
      drag.current = null;
      setLive(null);
      if (!state?.moved) return null;
      skipClick.current = true;
      return {
        token: state.token,
        dx: state.dx,
        dy: state.dy,
        from: state.from,
        over: state.over,
        width: state.width,
        left: state.left,
        top: state.top,
        height: state.height,
      };
    },
    cancel() {
      drag.current = null;
      setLive(null);
    },
    click(event: ReactMouseEvent): boolean {
      if (!skipClick.current) return false;
      skipClick.current = false;
      event.preventDefault();
      return true;
    },
  };
}

function shiftFor(index: number, from: number, over: number, width: number): number {
  if (index === from) return 0;
  if (from < over && index > from && index <= over) return -width;
  if (over < from && index < from && index >= over) return width;
  return 0;
}

function tabMotion(index: number, live: DragLive | null): { className: string; style?: CSSProperties } {
  if (!live) return { className: "" };
  if (index === live.from) {
    return { className: "dragging", style: { visibility: "hidden" } };
  }
  if (live.over == null) return { className: "" };
  const shift = shiftFor(index, live.from, live.over, live.width);
  if (shift === 0) return { className: "" };
  return { className: "shift", style: { transform: `translateX(${shift}px)` } };
}

function TabGhost({ live, className, label }: { live: DragLive; className: string; label: string }) {
  return createPortal(
    <div
      className={`tab-ghost ${className}`}
      style={{
        left: live.left,
        top: live.top,
        width: live.width,
        height: live.height,
        transform: `translate(${live.dx}px, ${live.dy}px)`,
      }}
    >
      <span className="drag">{label}</span>
      <span className="x">×</span>
    </div>,
    document.body,
  );
}

function Group({
  title,
  count,
  indent = 0,
  top = false,
  holds = false,
  children,
}: {
  title: string;
  count: number;
  indent?: number;
  /** Top-level sections are separated by a hairline. */
  top?: boolean;
  /** True while the view on screen lives inside this group. */
  holds?: boolean;
  children: ReactNode;
}) {
  // Closed at start: the sidebar opens as a list of sections, not a wall of
  // resources. A view that is already open on the first render (or arrives
  // later, from a tab, spotlight or another window) opens the group that holds
  // it, and the user can close it again after that.
  const [open, setOpen] = useState(holds);
  useEffect(() => {
    if (holds) setOpen(true);
  }, [holds]);
  return (
    <div>
      <button
        className={top ? "group top" : "group"}
        style={{ paddingLeft: 10 + indent }}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <i className={open ? "chevron" : "chevron closed"} />
        <span>{title}</span>
        <span className="muted">{count}</span>
      </button>
      {open ? <div className="children">{children}</div> : null}
    </div>
  );
}

/** True when the view on screen is this custom resource. */
function onCustomTarget(current: View | null, target: CrTarget): boolean {
  return (
    current?.kind === "custom" &&
    current.target.name === target.name &&
    current.target.version === target.version
  );
}

export function TopBar({ kubi }: { kubi: Kubi }) {
  const context = kubi.context;
  return (
    <header className="topbar">
      <div className="topbar-row">
        <span className="brand">Kubi</span>
        <span className="ctx-chip" title={context ? `Context: ${context}` : "No context selected"}>
          <i className="dot" style={{ background: context ? clusterColor(context) : "var(--dim)" }} />
          {context ?? "no cluster"}
        </span>
        {kubi.connecting ? <span className="muted">connecting…</span> : null}
        <span className="spacer" />
        <button onClick={kubi.refresh} disabled={kubi.refreshing} aria-busy={kubi.refreshing}>
          {kubi.refreshing ? <i className="spin" /> : null}
          Refresh
        </button>
        <button
          className="icon"
          title="Settings"
          aria-label="Settings"
          onClick={() => kubi.setSettingsOpen(true)}
        >
          <GearIcon />
        </button>
      </div>
      {kubi.errors.map((message, index) => (
        <div key={`${index}-${message.slice(0, 24)}`} className="error-banner">
          <p className="wrap">{message}</p>
          <button aria-label="Dismiss error" onClick={() => kubi.dismissError(index)}>
            ×
          </button>
        </div>
      ))}
    </header>
  );
}

export function Sidebar({ kubi }: { kubi: Kubi }) {
  const gateway = installedGateway(kubi.customResources);
  const groups = crGroups(kubi.customResources);
  const current = kubi.activeTab?.view ?? null;
  const onCluster = kubi.active == null && kubi.home === "cluster";
  const onArgo = kubi.active == null && kubi.home === "argo";
  return (
    <nav className="nav">
      <button className={onCluster ? "nav-item active" : "nav-item"} onClick={() => kubi.openView({ kind: "overview" })}>
        Overview
      </button>
      {argoInstalled(kubi.customResources) ? (
        <button className={onArgo ? "nav-item active" : "nav-item"} onClick={() => kubi.openView({ kind: "argo" })}>
          Argo CD
        </button>
      ) : null}
      {NAV.map(([title, kinds]) => {
        const shown = title === "Gateway" ? gateway : kinds;
        if (title === "Gateway" && shown.length === 0) return null;
        return (
          <Group
            key={title}
            title={title}
            count={shown.length}
            top
            holds={current?.kind === "resource" && shown.includes(current.resource)}
          >
            {shown.map((kind) => (
              <NavItem
                key={kind}
                label={TITLES[kind]}
                active={current?.kind === "resource" && current.resource === kind}
                onClick={() => kubi.openView({ kind: "resource", resource: kind })}
              />
            ))}
          </Group>
        );
      })}
      <Group
        title="Custom Resources"
        count={1 + groups.reduce((sum, [, items]) => sum + items.length, 0)}
        top
        holds={
          current?.kind === "custom" ||
          (current?.kind === "resource" && current.resource === "customResourceDefinitions")
        }
      >
        <NavItem
          label="Definitions"
          active={current?.kind === "resource" && current.resource === "customResourceDefinitions"}
          onClick={() => kubi.openView({ kind: "resource", resource: "customResourceDefinitions" })}
        />
        {groups.map(([group, targets]) => (
          <Group
            key={group}
            title={group}
            count={targets.length}
            indent={12}
            holds={targets.some((target) => onCustomTarget(current, target))}
          >
            {targets.map((target) => (
              <NavItem
                key={`${target.group}/${target.kind}/${target.version}`}
                label={target.kind}
                active={onCustomTarget(current, target)}
                onClick={() => kubi.openView({ kind: "custom", target })}
              />
            ))}
          </Group>
        ))}
      </Group>
    </nav>
  );
}

function NavItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={active ? "nav-item active" : "nav-item"} onClick={onClick}>
      {label}
    </button>
  );
}

export function NamespaceSelect({ kubi }: { kubi: Kubi }) {
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = kubi.activeTab?.namespace ?? null;
  const needle = prefix.toLowerCase();
  const shown: (string | null)[] = [];
  if (needle === "") shown.push(null);
  for (const namespace of kubi.namespaces) {
    if (needle === "" || namespace.toLowerCase().startsWith(needle)) shown.push(namespace);
  }

  const positionMenu = () => {
    const el = buttonRef.current;
    const target = menuRef.current;
    if (!el || !target || !open) return;
    const rect = el.getBoundingClientRect();
    const menuHeight = target.offsetHeight || 240;
    target.style.left = `${Math.max(0, rect.left)}px`;
    let top = rect.bottom + 2;
    if (rect.bottom + menuHeight > window.innerHeight - 8) {
      top = rect.top - menuHeight - 2;
    }
    target.style.top = `${Math.max(0, Math.min(top, window.innerHeight - menuHeight - 4))}px`;
    target.style.display = "block";
  };

  const kubiRef = useRef(kubi);
  useEffect(() => {
    kubiRef.current = kubi;
  }, [kubi]);

  useEffect(() => {
    if (!open) return;
    positionMenu();
    const kubi = kubiRef.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Backspace") {
        setPrefix((value) => value.slice(0, -1));
        event.preventDefault();
      } else if (event.key === "Enter") {
        const first = shown[0];
        if (shown.length > 0) kubi.setNamespace(first ?? null);
        setOpen(false);
        event.preventDefault();
      } else if (event.key === "Escape") {
        setOpen(false);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        setPrefix((value) => value + event.key);
        event.preventDefault();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, shown]);

  return (
    <div className="ns" ref={root}>
      <span className="muted">Namespace</span>
      <button ref={buttonRef} className="current" onClick={() => {
        setPrefix("");
        setOpen((value) => !value);
      }}>
        {current ?? "All namespaces"}
        {open && prefix ? `  ${prefix}` : ""}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="ns-menu"
          style={{
            position: "fixed",
            zIndex: 1000,
            maxHeight: "240px",
            overflowY: "auto",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow)",
            padding: "var(--sp2)",
          }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {shown.length === 0 ? <div className="muted">No namespaces</div> : null}
          {shown.map((item) => {
            const label = item ?? "All namespaces";
            const on = item === current;
            return (
              <div key={item ?? "__all__"} className="ns-menu-item">
                <button
                  className={on ? "on" : ""}
                  onClick={() => {
                    kubi.setNamespace(item);
                    setOpen(false);
                  }}
                >
                  {label}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ResourceScreen({ kubi }: { kubi: Kubi }) {
  const gesture = useTabDrag();
  const strip = useRef<HTMLDivElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  // The filter shortcut is part of the keymap, so the window hands us the focus
  // callback instead of handling the key itself.
  useEffect(() => {
    kubi.bindFilter(() => {
      filterBox.current?.focus();
      filterBox.current?.select();
    });
    return () => kubi.bindFilter(null);
    // Registered once: the callback only touches the input ref above.
  }, []);
  const tab = kubi.activeTab;
  if (!tab) return null;
  const kind: ResourceKind | null = tab.view.kind === "resource" ? tab.view.resource : null;
  const match = rowFilter(tab.filter);
  const selected = tab.rows.find((row) => row.uid === tab.selected) ?? null;
  const picked = tab.selection.length > 0;
  return (
    <div className="center">
      <div className="tabs" ref={strip}>
        {kubi.tabs.map((item, index) => {
          const motion = tabMotion(index, gesture.live);
          return (
          <div
            key={item.id}
            className={["tab", index === kubi.active ? "active" : "", motion.className].filter(Boolean).join(" ")}
            style={motion.style}
            data-tab-index={index}
          >
            <button
              className="drag"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                if (strip.current) gesture.down(String(index), index, event, strip.current, "data-tab-index");
              }}
              onPointerMove={(event) => {
                const bounds = strip.current?.getBoundingClientRect();
                const inside =
                  bounds != null &&
                  event.clientX >= bounds.left &&
                  event.clientX <= bounds.right &&
                  event.clientY >= bounds.top &&
                  event.clientY <= bounds.bottom;
                gesture.move(event, inside);
              }}
              onPointerUp={() => {
                const result = gesture.up();
                if (!result || result.over == null || result.over === result.from) return;
                kubi.reorderTabs(result.from, result.over);
              }}
              onPointerCancel={gesture.cancel}
              onClick={(event) => {
                if (gesture.click(event)) return;
                kubi.focusTab(index);
              }}
            >
              {/* The rail marks a context with a colored strip; a tab carries
                  the same color, so its cluster is readable at a glance. */}
              <i className="tab-context" style={{ background: clusterColor(item.context) }} />
              {viewTitle(item.view)}
              {/* The name only earns its place once tabs of several clusters are open. */}
              {kubi.clustered ? <span className="tab-cluster">{item.context}</span> : null}
            </button>
            <button
              className="x"
              onClick={() => kubi.closeTab(index)}
              aria-label="Close tab"
            >
              ×
            </button>
          </div>
          );
        })}
        {gesture.live ? (
          <TabGhost
            live={gesture.live}
            className={gesture.live.from === kubi.active ? "tab active" : "tab"}
            label={viewTitle(kubi.tabs[gesture.live.from]?.view ?? tab.view)}
          />
        ) : null}
      </div>
      <div className="toolbar">
        <NamespaceSelect kubi={kubi} />
        <input
          ref={filterBox}
          className={match.invalid ? "filter invalid" : "filter"}
          value={tab.filter}
          placeholder="Filter (regex)"
          aria-label="Filter rows"
          title={`Case-insensitive regular expression · ${bindingKeys(kubi.keymap.focusFilter).join("+")} focuses it`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => kubi.setFilter(event.target.value)}
        />
        {match.invalid ? (
          <span className="hint" title="Incomplete regex, matching plain text">
            literal
          </span>
        ) : null}
        <span className="count">{visibleRows(tab).length}</span>
        <span className="spacer" />
        {kind && canLogs(kind) && selected ? (
          <IconButton label="Logs" onClick={kubi.openLogs}>
            <LogsIcon />
          </IconButton>
        ) : null}
        {kind && canExec(kind) && selected ? (
          <IconButton label="Exec" onClick={kubi.openExec}>
            <ExecIcon />
          </IconButton>
        ) : null}
        {kind && canForward(kind) && selected ? (
          <IconButton label="Port forward" onClick={kubi.askForward}>
            <ForwardIcon />
          </IconButton>
        ) : null}
        {kind && canRestart(kind) && picked ? (
          <IconButton label="Restart" onClick={kubi.restartSelected}>
            <RestartIcon />
          </IconButton>
        ) : null}
        {picked ? (
          <IconButton label="Delete" danger onClick={kubi.askDelete}>
            <TrashIcon />
          </IconButton>
        ) : null}
        <button
          className="create"
          onClick={() => {
            kubi.setCreateYaml(objectTemplate(tab.view, tab.namespace));
            kubi.openCreate();
          }}
        >
          <PlusIcon />
          Create
        </button>
      </div>
      <ObjectTable kubi={kubi} />
      {kubi.menu ? <RowMenu kubi={kubi} /> : null}
    </div>
  );
}

type RowFilter = {
  test: (row: ResourceRow) => boolean;
  /** The pattern does not compile yet, so plain text matching is in use. */
  invalid: boolean;
};

/**
 * The row filter is a case-insensitive regular expression. While the pattern is
 * still incomplete (a lone `(`, say) it degrades to plain substring matching so
 * the table never blanks out mid-typing.
 */
function rowFilter(filter: string): RowFilter {
  const needle = filter.trim();
  if (needle === "") return { test: () => true, invalid: false };
  try {
    const pattern = new RegExp(needle, "i");
    return { test: (row) => pattern.test(row.name), invalid: false };
  } catch {
    const plain = needle.toLowerCase();
    return { test: (row) => row.name.toLowerCase().includes(plain), invalid: true };
  }
}

function visibleRows(tab: NonNullable<Kubi["activeTab"]>): ResourceRow[] {
  const match = rowFilter(tab.filter);
  const rows = tab.rows.filter(match.test);
  const field = fieldFromKey(tab.sortKey);
  return [...rows].sort((a, b) => compareRows(a, b, field, tab.sortAsc));
}

function fieldFromKey(key: string): Field {
  return key.startsWith("cell:") ? { cell: key.slice(5) } : (key as Field);
}

function ObjectTable({ kubi }: { kubi: Kubi }) {
  const tab = kubi.activeTab;
  if (!tab) return null;
  const cols = columnsFor(tab.view);
  const rows = visibleRows(tab);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((col) => (
              <th
                key={col.title}
                className={isNumericField(col.field) ? "num" : undefined}
                style={{ width: col.width }}
                onClick={() => kubi.toggleSort(columnKey(col.field))}
              >
                {col.title}
                {tab.sortKey === columnKey(col.field) ? (tab.sortAsc ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tab.waiting && rows.length === 0 ? (
            <tr>
              <td className="empty" colSpan={cols.length}>
                Loading…
              </td>
            </tr>
          ) : null}
          {!tab.waiting && rows.length === 0 ? (
            <tr>
              <td className="empty" colSpan={cols.length}>
                No matching objects
              </td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <tr
              key={row.uid}
              className={tab.selection.includes(row.uid) ? "selected" : ""}
              onMouseDown={(event) => {
                if (event.shiftKey) event.preventDefault();
              }}
              onClick={(event) => kubi.selectRow(row.uid, event.shiftKey, rows.map((item) => item.uid))}
              onContextMenu={(event) => {
                event.preventDefault();
                kubi.openMenu(event.clientX, event.clientY, row.uid);
              }}
            >
              {cols.map((col) => {
                const warning = col.field === "name" ? kubi.warning(row) : null;
                return (
                  <td
                    key={col.title}
                    className={isNumericField(col.field) ? "num" : undefined}
                    title={col.field === "name" ? row.name : undefined}
                    style={{ width: col.width, color: col.colored ? tone(row.tone) : undefined }}
                  >
                    {col.colored ? <i className="dot" style={{ background: tone(row.tone) }} /> : null}
                    {warning ? <WarningMark warning={warning} /> : null}
                    {fieldText(row, col.field, liveAge(row.ageSecs, tab.observedAt, kubi.now))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tone(value: ResourceRow["tone"]): string {
  if (value === "ok") return "var(--ok)";
  if (value === "warn") return "var(--warn)";
  if (value === "bad") return "var(--bad)";
  return "var(--muted)";
}

/** Marks a row whose object has warning events, without opening it. */
function WarningMark({ warning }: { warning: ObjectWarning }) {
  const label = `${warning.count} warning event${warning.count === 1 ? "" : "s"}: ${warning.reason}`;
  return (
    <span className="warn-mark" title={label} aria-label={label} role="img">
      <WarnIcon />
    </span>
  );
}

/** Settings: a gear, matching the stroke of the other icons. */
function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.9v1.6M8 12.5v1.6M2.9 8h1.6M11.5 8h1.6M4.4 4.4l1.1 1.1M10.5 10.5l1.1 1.1M11.6 4.4l-1.1 1.1M5.5 10.5l-1.1 1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M8 2.4 14.2 13H1.8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.3v3.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M8 11.1h.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Narrowest the detail panel can be dragged. */
const DETAIL_MIN = 280;
/** Object list width that stays visible when the panel is dragged as wide as the
 * window allows, so the table can never be covered completely. */
const LIST_KEEP = 360;

/** Widest the detail panel may get inside a workspace of `room` pixels. */
function panelMax(room: number): number {
  return Math.max(DETAIL_MIN, room - LIST_KEEP);
}

export function Detail({ kubi, width, onWidth }: { kubi: Kubi; width: number; onWidth: (width: number) => void }) {
  const tab = kubi.activeTab;
  const row = tab?.rows.find((item) => item.uid === tab.selected);
  const dragging = useRef<{ x: number; width: number } | null>(null);
  const aside = useRef<HTMLElement | null>(null);
  // A panel dragged wide is clamped back when the window shrinks, so the object
  // list never disappears behind it.
  useEffect(() => {
    const fit = () => {
      const room = aside.current?.parentElement?.clientWidth;
      if (room != null && width > panelMax(room)) onWidth(panelMax(room));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [width, onWidth]);
  if (!tab || !row) return null;
  const kind = tab.view.kind === "resource" ? tab.view.resource : null;
  // Events load with the selection, so warnings are on hand before the tab is opened.
  const events = tab.eventsFor === row.uid ? tab.events : null;
  // Probe failures of a pod that is running again say nothing about now.
  const shown = visibleEvents(kind, row, events);
  const warnings = shown.filter((event) => event.kind === "Warning");
  const hidden = (events?.length ?? 0) - shown.length;
  return (
    <aside className="detail" ref={aside} style={{ width }}>
      <button
        className="grip"
        aria-label="Resize panel"
        onPointerDown={(event) => {
          dragging.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragging.current;
          if (!drag) return;
          const room = aside.current?.parentElement?.clientWidth ?? window.innerWidth;
          onWidth(Math.min(panelMax(room), Math.max(DETAIL_MIN, drag.width + (drag.x - event.clientX))));
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
      />
      <header>
        <div>
          <div className="name wrap">{row.name}</div>
          <div className="muted wrap">
            {viewTitle(tab.view)} · {row.namespace || "-"}
          </div>
        </div>
        <div className="actions">
          {kind && canLogs(kind) ? (
            <IconButton label="Logs" onClick={kubi.openLogs}>
              <LogsIcon />
            </IconButton>
          ) : null}
          {kind && canExec(kind) ? (
            <IconButton label="Exec" onClick={kubi.openExec}>
              <ExecIcon />
            </IconButton>
          ) : null}
          {kind && canRestart(kind) ? (
            <IconButton label="Restart" onClick={kubi.restartSelected}>
              <RestartIcon />
            </IconButton>
          ) : null}
          <IconButton label="Delete" danger onClick={kubi.askDelete}>
            <TrashIcon />
          </IconButton>
          <button onClick={kubi.clearSelection}>×</button>
        </div>
      </header>
      <div className="subtabs">
        <button className={tab.detailTab === "overview" ? "active" : ""} onClick={() => kubi.setDetailTab("overview")}>
          Overview
        </button>
        <button className={tab.detailTab === "yaml" ? "active" : ""} onClick={() => kubi.setDetailTab("yaml")}>
          YAML
        </button>
        <button className={tab.detailTab === "events" ? "active" : ""} onClick={() => kubi.setDetailTab("events")}>
          Events
          {warnings.length > 0 ? (
            <span className="badge warn" title={`${warnings.length} warning events`}>
              {warnings.length}
            </span>
          ) : null}
        </button>
        {kind && supportsMetrics(kind) ? (
          <button className={tab.detailTab === "metrics" ? "active" : ""} onClick={() => kubi.setDetailTab("metrics")}>
            Metrics
          </button>
        ) : null}
        {kind && hasValues(kind) ? (
          <button className={tab.detailTab === "data" ? "active" : ""} onClick={() => kubi.setDetailTab("data")}>
            Data
          </button>
        ) : null}
        {kind && canSources(kind) ? (
          <button className={tab.detailTab === "sources" ? "active" : ""} onClick={() => kubi.setDetailTab("sources")}>
            Sources
          </button>
        ) : null}
      </div>
      <div className="body">
        {tab.detailTab === "overview" ? (
          <OverviewTab
            row={row}
            kind={kind}
            title={viewTitle(tab.view)}
            ageSecs={liveAge(row.ageSecs, tab.observedAt, kubi.now)}
            warnings={warnings}
            onEvents={warnings.length > 0 ? () => kubi.setDetailTab("events") : undefined}
            onServicePort={
              kind === "services" ? (port) => kubi.forwardServicePort(row.namespace, row.name, port) : undefined
            }
            containers={tab.containers}
            containersReady={tab.containersFor === tab.selected}
          />
        ) : null}
        {tab.detailTab === "yaml" ? (
          <YamlTab kubi={kubi} secret={kind != null && isSecret(kind)} ready={tab.yamlFor === tab.selected} yaml={tab.yaml} />
        ) : null}
        {tab.detailTab === "data" ? (
          <DataTab kubi={kubi} secret={kind != null && isSecret(kind)} ready={tab.dataFor === tab.selected} entries={tab.data} />
        ) : null}
        {tab.detailTab === "events" ? (
          <EventsTab ready={tab.eventsFor === tab.selected} events={shown} hidden={hidden} />
        ) : null}
        {tab.detailTab === "sources" ? (
          <SourcesTab ready={tab.sourcesFor === tab.selected} sources={tab.sources} />
        ) : null}
        {tab.detailTab === "metrics" ? <Metrics kubi={kubi} row={row} /> : null}
      </div>
    </aside>
  );
}

function IconButton({
  label,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={danger ? "icon bad" : "icon"}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3M4.5 4.5l.6 8.2h5.8l.6-8.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 6.5v4.2M9 6.5v4.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M12.5 8a4.5 4.5 0 1 1-1.2-3.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12.6 2.8v2.7H9.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExecIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 4.5h10v8H3z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 8.2l1.6 1.3L5 10.8M8.2 10.8H11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M2.5 8h7M7.2 5.2 10.5 8 7.2 10.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 4.5v7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="5.2" y="4.2" width="7" height="8.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.8 10.8V3.5h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M3.2 8.6l3.1 3.1 6.5-7.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 2.5h5.2L12.5 5.8V13.5H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 2.7V6h3.2M6 8.2h4.5M6 10.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function RowMenu({ kubi }: { kubi: Kubi }) {
  const menu = kubi.menu;
  const tab = kubi.activeTab;
  const row = tab?.rows.find((item) => item.uid === menu?.uid);
  const kind = tab?.view.kind === "resource" ? tab.view.resource : null;
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") kubi.closeMenu();
    };
    const onMouse = () => kubi.closeMenu();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
    };
  }, [menu, kubi]);
  if (!menu || !row || !tab) return null;
  return (
    <div
      className="menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 220) }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {kind && canLogs(kind) ? (
        <button
          onClick={() => {
            kubi.closeMenu();
            kubi.openLogs();
          }}
        >
          <LogsIcon /> Logs
        </button>
      ) : null}
      {kind && canExec(kind) ? (
        <button
          onClick={() => {
            kubi.closeMenu();
            kubi.openExec();
          }}
        >
          <ExecIcon /> Exec
        </button>
      ) : null}
      {kind && canForward(kind) ? (
        <button
          onClick={() => {
            kubi.closeMenu();
            kubi.askForward();
          }}
        >
          <ForwardIcon /> Port forward
        </button>
      ) : null}
      {kind && canRestart(kind) ? (
        <button
          onClick={() => {
            kubi.closeMenu();
            kubi.restartSelected();
          }}
        >
          <RestartIcon /> Restart
        </button>
      ) : null}
      <button
        className="bad"
        onClick={() => {
          kubi.closeMenu();
          kubi.askDelete();
        }}
      >
        <TrashIcon /> Delete
      </button>
    </div>
  );
}

function sessionTitle(tab: Kubi["dockTabs"][number]): string {
  if (tab.pane === "log") return logTitle(tab.kind, tab.namespace, tab.name);
  return `Exec ${tab.name}`;
}

export function SessionDrawer({
  kubi,
  height,
  onHeight,
}: {
  kubi: Kubi;
  height: number;
  onHeight: (height: number) => void;
}) {
  const dragging = useRef<{ y: number; height: number } | null>(null);
  const gesture = useTabDrag();
  const panel = useRef<HTMLElement>(null);
  const visible = kubi.dockTabs.filter((tab) => !tab.detached);
  const active = visible.find((tab) => tab.label === kubi.activeDock) ?? visible[0] ?? null;
  if (!active) return null;
  const max = Math.max(120, window.innerHeight / 2);
  const shown = Math.min(max, Math.max(120, height));
  return (
    <section ref={panel} className="log-drawer" style={{ height: shown }} aria-label="Logs and exec">
      <button
        className="grip"
        aria-label="Resize panel"
        onPointerDown={(event) => {
          dragging.current = { y: event.clientY, height: shown };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragging.current;
          if (!drag) return;
          const limit = Math.max(120, window.innerHeight / 2);
          onHeight(Math.min(limit, Math.max(120, drag.height + (drag.y - event.clientY))));
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
      />
      <div className="log-tabs">
        {visible.map((tab, index) => {
          const motion = tabMotion(index, gesture.live);
          const title = sessionTitle(tab);
          return (
            <div
              key={tab.label}
              data-dock-index={index}
              className={["log-tab", tab.label === active.label ? "active" : "", motion.className].filter(Boolean).join(" ")}
              style={motion.style}
            >
              <button
                className="drag"
                draggable={false}
                title={title}
                onDragStart={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  if (panel.current) gesture.down(tab.label, index, event, panel.current, "data-dock-index");
                }}
                onPointerMove={(event) => {
                  const bounds = panel.current?.getBoundingClientRect();
                  const inside =
                    bounds != null &&
                    event.clientX >= bounds.left &&
                    event.clientX <= bounds.right &&
                    event.clientY >= bounds.top &&
                    event.clientY <= bounds.bottom;
                  gesture.move(event, inside);
                }}
                onPointerUp={(event) => {
                  const result = gesture.up();
                  if (!result) return;
                  const bounds = panel.current?.getBoundingClientRect();
                  const outside =
                    bounds != null &&
                    (event.clientX < bounds.left ||
                      event.clientX > bounds.right ||
                      event.clientY < bounds.top ||
                      event.clientY > bounds.bottom);
                  if (outside && bounds) {
                    kubi.detachDock(result.token, { width: bounds.width, height: bounds.height });
                    return;
                  }
                  if (result.over != null && result.over !== result.from) kubi.reorderDock(result.from, result.over);
                }}
                onPointerCancel={gesture.cancel}
                onClick={(event) => {
                  if (gesture.click(event)) return;
                  kubi.selectDock(tab.label);
                }}
              >
                {title}
              </button>
              <button className="x" aria-label={`Close ${tab.name}`} onClick={() => kubi.closeDock(tab.label)}>
                ×
              </button>
            </div>
          );
        })}
        {gesture.live ? (
          <TabGhost
            live={gesture.live}
            className={visible[gesture.live.from]?.label === active.label ? "log-tab active" : "log-tab"}
            label={visible[gesture.live.from] ? sessionTitle(visible[gesture.live.from]) : ""}
          />
        ) : null}
      </div>
      {active.pane === "log" ? (
        <LogPane
          logs={active}
          follow={active.id}
          onPod={kubi.setLogPod}
          onContainer={kubi.setLogContainer}
          onPrevious={kubi.setLogPrevious}
          onTimestamps={kubi.setLogTimestamps}
          onClose={() => kubi.closeDock(active.label)}
        />
      ) : (
        <ExecPane
          session={active}
          onContainer={kubi.setExecContainer}
          onClose={() => kubi.closeDock(active.label)}
          readText={() => kubi.readExecText(active.label)}
          bind={(write) => kubi.bindExec(active.label, write)}
          onInput={kubi.execInput}
          onResize={kubi.execResize}
        />
      )}
    </section>
  );
}

export function OverviewScreen({ kubi }: { kubi: Kubi }) {
  const overview = kubi.overview;
  return (
    <div className="center">
      <div className="scroll-page">
        <div className="page">
          <h1>Overview</h1>
          {kubi.loadingConfig ? <p>Reading kubeconfig…</p> : null}
          {!kubi.loadingConfig && kubi.contexts.length === 0 ? (
            <p>No contexts in kubeconfig. Open a kubeconfig file, or create ~/.kube/config.</p>
          ) : null}
          {kubi.connecting ? <p>Connecting…</p> : null}
          {!kubi.context && !kubi.loadingConfig && kubi.contexts.length > 0 ? <p>Select a cluster.</p> : null}
          {kubi.context && !overview && !kubi.connecting ? <p>Loading cluster summary…</p> : null}
          {overview ? (
            <ClusterCards
              overview={overview}
              cluster={kubi.contexts.find((item) => item.name === kubi.context)?.cluster ?? ""}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ClusterCards({ overview, cluster }: { overview: Kubi["overview"]; cluster: string }) {
  if (!overview) return null;
  const warnings = overview.warningEvents == null ? "-" : String(overview.warningEvents);
  const hasCpu = overview.cpuMillis != null && overview.cpuAllocatableMillis != null;
  const hasMem = overview.memBytes != null && overview.memAllocatableBytes != null;
  return (
    <>
      <p className="muted">
        {cluster ? `${overview.context}  ·  ${cluster}` : overview.context}
      </p>
      <section className="card">
        <div className="stats">
          <Stat title="Nodes ready" value={`${overview.nodesReady}/${overview.nodesTotal}`} color="var(--ok)" />
          <Stat title="Pods" value={String(overview.pods)} color="var(--accent)" />
          <Stat title="Namespaces" value={String(overview.namespaces)} />
          <Stat title="Warnings" value={warnings} color={overview.warningEvents ? "var(--bad)" : "var(--muted)"} />
        </div>
        {overview.note ? <p className="muted">{overview.note}</p> : null}
      </section>
      <section className="card">
        <h2>Pods</h2>
        <ShareBar
          parts={[
            ["Running", overview.podsRunning, "var(--ok)"],
            ["Pending", overview.podsPending, "var(--warn)"],
            ["Failed", overview.podsFailed, "var(--bad)"],
            ["Succeeded", overview.podsSucceeded, "var(--muted)"],
            ["Unknown", overview.podsUnknown, "var(--text)"],
          ]}
        />
      </section>
      {hasCpu || hasMem ? (
        <section className="card">
          <h2>Capacity</h2>
          {hasCpu && overview.cpuMillis != null && overview.cpuAllocatableMillis != null ? (
            <Usage title="CPU" used={overview.cpuMillis} total={overview.cpuAllocatableMillis} format={formatCpu} />
          ) : null}
          {hasMem && overview.memBytes != null && overview.memAllocatableBytes != null ? (
            <Usage title="Memory" used={overview.memBytes} total={overview.memAllocatableBytes} format={formatBytes} />
          ) : null}
        </section>
      ) : null}
      {overview.warnings.length > 0 ? (
        <section className="card">
          <h2>Recent warnings</h2>
          {overview.warnings.map((warning, index) => (
            <div key={`${warning.object}-${index}`}>
              <div className="warn">
                {warning.reason} {warning.object} {formatAge(warning.ageSecs)}
              </div>
              {warning.message ? <div className="muted wrap">{warning.message}</div> : null}
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

function Stat({ title, value, color }: { title: string; value: string; color?: string }) {
  return (
    <div className="stat">
      <span className="muted">{title}</span>
      <b style={{ color }}>{value}</b>
    </div>
  );
}

function ShareBar({ parts }: { parts: [string, number, string][] }) {
  const total = parts.reduce((sum, part) => sum + part[1], 0);
  const shown = parts.filter((part) => part[1] > 0);
  if (total === 0) return <div className="muted">none</div>;
  return (
    <>
      <div className="bar">
        {shown.map(([name, value, color]) => (
          <i key={name} style={{ width: `${(value / total) * 100}%`, background: color }} />
        ))}
      </div>
      <div className="legend">
        {shown.map(([name, value, color]) => (
          <span key={name} style={{ color }}>
            {name} {value}
          </span>
        ))}
      </div>
    </>
  );
}

function Usage({ title, used, total, format }: { title: string; used: number; total: number; format: (value: number) => string }) {
  const ratio = total <= 0 ? 0 : Math.min(1, used / total);
  return (
    <div>
      <div>
        {title} {format(used)} / {format(total)}
      </div>
      <div className="usage">
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export function ArgoScreen({ kubi }: { kubi: Kubi }) {
  const argo = kubi.overview?.argo ?? null;
  const waiting = kubi.overview == null || kubi.connecting;
  return (
    <div className="center">
      <div className="scroll-page">
        <div className="page wide">
          <h1>Argo CD</h1>
          {!argo && waiting ? <p>Loading applications…</p> : null}
          {!argo && !waiting ? <p>Argo CD applications are not available.</p> : null}
          {argo?.note ? <p className="bad">{argo.note}</p> : null}
          {argo ? (
            <>
              <div className="rings">
                <RingCard title="Health" value={count(argo.apps, "health", "Healthy")} total={argo.apps.length} legend={healthLegend(argo.apps)} />
                <RingCard title="Sync" value={count(argo.apps, "sync", "Synced")} total={argo.apps.length} legend={syncLegend(argo.apps)} />
              </div>
              <section className="card">
                <h2>Applications</h2>
                {argo.apps.length === 0 ? (
                  <p className="muted">No applications</p>
                ) : (
                  <ArgoTable
                    headers={["Name", "Health", "Sync"]}
                    rows={argo.apps.map((app) => ({
                      key: `${app.namespace}/${app.name}`,
                      onClick: () => kubi.openNamed(argo.target, app.namespace, app.name),
                      cells: [
                        { text: objectName(app.namespace, app.name) },
                        { text: app.health, color: statusTone(app.health) },
                        { text: app.sync, color: statusTone(app.sync) },
                      ],
                    }))}
                  />
                )}
              </section>
              <section className="card">
                <h2>ApplicationSets</h2>
                {argo.setsNote ? <p className={argo.setsNote === "ApplicationSet is not installed" ? "muted" : "bad"}>{argo.setsNote}</p> : null}
                {argo.appSets.length === 0 && !argo.setsNote ? <p className="muted">No application sets</p> : null}
                {argo.appSets.length > 0 ? (
                  <ArgoTable
                    headers={["Name", "Applications", "Status"]}
                    rows={argo.appSets.map((set) => {
                      const setsTarget = argo.setsTarget;
                      return {
                        key: `${set.namespace}/${set.name}`,
                        onClick: setsTarget ? () => kubi.openNamed(setsTarget, set.namespace, set.name) : undefined,
                        cells: [
                          { text: objectName(set.namespace, set.name) },
                          { text: String(set.applications) },
                          { text: set.status, color: statusTone(set.status) },
                        ],
                      };
                    })}
                  />
                ) : null}
              </section>
              <section className="card">
                <h2>Repositories</h2>
                {argo.reposNote ? <p className="bad">{argo.reposNote}</p> : null}
                {argo.repos.length === 0 && !argo.reposNote ? <p className="muted">No repositories</p> : null}
                {argo.repos.length > 0 ? (
                  <ArgoTable
                    headers={["Name", "URL", "Type", "Project"]}
                    rows={argo.repos.map((repo) => ({
                      key: `${repo.project}/${repo.name}/${repo.url}`,
                      cells: [
                        { text: repo.name },
                        { text: repo.url || "-" },
                        { text: repo.repoType },
                        { text: repo.project },
                      ],
                    }))}
                  />
                ) : null}
              </section>
              <section className="card">
                <h2>Clusters</h2>
                {argo.clustersNote ? <p className="bad">{argo.clustersNote}</p> : null}
                {argo.clusters.length === 0 && !argo.clustersNote ? <p className="muted">No clusters</p> : null}
                {argo.clusters.length > 0 ? (
                  <ArgoTable
                    headers={["Name", "Server"]}
                    rows={argo.clusters.map((cluster) => ({
                      key: `${cluster.name}/${cluster.server}`,
                      cells: [{ text: cluster.name }, { text: cluster.server || "-" }],
                    }))}
                  />
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ArgoTable({ headers, rows }: { headers: string[]; rows: ArgoRow[] }) {
  return (
    <div className="argo-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.onClick ? "clickable" : undefined} onClick={row.onClick}>
              {row.cells.map((cell, index) => (
                <td key={`${row.key}-${index}`} style={cell.color ? { color: cell.color } : undefined}>
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function objectName(namespace: string, name: string): string {
  return namespace ? `${namespace}/${name}` : name;
}

function statusTone(value: string): string | undefined {
  if (value === "Healthy" || value === "Synced") return "var(--ok)";
  if (value === "Progressing" || value === "OutOfSync") return "var(--warn)";
  if (value === "Degraded" || value === "Missing" || value === "Suspended") return "var(--bad)";
  if (value === "Unknown" || value === "-" || value === "") return "var(--muted)";
  return "var(--bad)";
}

type ArgoCell = { text: string; color?: string };
type ArgoRow = { key: string; cells: ArgoCell[]; onClick?: () => void };

function count(apps: ArgoApp[], field: "health" | "sync", value: string): number {
  return apps.filter((app) => app[field] === value).length;
}

function legend(parts: [string, number, string][]): [string, number, string][] {
  return parts.filter((part): part is [string, number, string] => part[1] > 0);
}

function healthLegend(apps: ArgoApp[]): [string, number, string][] {
  const unknown = apps.filter((app) => !["Healthy", "Degraded", "Progressing", "Missing"].includes(app.health)).length;
  return legend([
    ["Degraded", count(apps, "health", "Degraded"), "var(--bad)"],
    ["Progressing", count(apps, "health", "Progressing"), "var(--warn)"],
    ["Missing", count(apps, "health", "Missing"), "var(--bad)"],
    ["Unknown", unknown, "var(--muted)"],
  ]);
}

function syncLegend(apps: ArgoApp[]): [string, number, string][] {
  const unknown = apps.filter((app) => app.sync !== "Synced" && app.sync !== "OutOfSync").length;
  return legend([
    ["OutOfSync", count(apps, "sync", "OutOfSync"), "var(--warn)"],
    ["Unknown", unknown, "var(--muted)"],
  ]);
}

function RingCard({ title, value, total, legend }: { title: string; value: number; total: number; legend: [string, number, string][] }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const ratio = total === 0 ? 0 : value / total;
  return (
    <section className="card ring-card">
      <h2>{title}</h2>
      <div className="ring">
        <svg width="96" height="96" viewBox="0 0 96 96">
          <circle cx="48" cy="48" r={radius} fill="none" stroke="#232c39" strokeWidth="6" />
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="none"
            stroke="#3fb950"
            strokeWidth="6"
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            transform="rotate(-90 48 48)"
          />
          <text x="48" y="52" textAnchor="middle" fill="#e6ebf2" fontSize="12">
            {value}/{total}
          </text>
        </svg>
      </div>
      <div className="legend">
        {legend.map(([name, countValue, color]) => (
          <span key={name} style={{ color }}>
            {name} {countValue}
          </span>
        ))}
      </div>
    </section>
  );
}

function OverviewTab({
  row,
  kind,
  title,
  ageSecs,
  warnings,
  onEvents,
  onServicePort,
  containers,
  containersReady,
}: {
  row: ResourceRow;
  kind: ResourceKind | null;
  title: string;
  ageSecs: number;
  warnings: EventInfo[];
  onEvents?: () => void;
  onServicePort?: (port: number) => void;
  containers: PodContainer[] | null;
  containersReady: boolean;
}) {
  const facts = resourceFacts(kind, row);
  return (
    <div className="detail-stack">
      {warnings.length > 0 ? (
        <section className="card warn-card">
          <h2>
            Warnings
            <span className="badge warn">{warnings.length}</span>
          </h2>
          {warnings.slice(0, 3).map((event, index) => (
            <EventRow event={event} showType={false} key={`${event.reason}-${event.ageSecs ?? "?"}-${index}`} />
          ))}
          {onEvents ? (
            <button className="ghost" onClick={onEvents}>
              {warnings.length > 3 ? `All ${warnings.length} events` : "Open events"}
            </button>
          ) : null}
        </section>
      ) : null}
      <section className="card">
        <h2>Summary</h2>
        <Meta label="Status" value={row.status} />
        {row.namespace ? <Meta label="Namespace" value={row.namespace} /> : null}
        <Meta label="Age" value={formatAge(ageSecs)} />
        {shown(cell(row, "controlledBy")) ? <Meta label="Controlled by" value={cell(row, "controlledBy")} /> : null}
        {shown(cell(row, "managedBy")) ? <Meta label="Managed by" value={cell(row, "managedBy")} /> : null}
        {shown(row.ready) ? <Meta label="Ready" value={row.ready} /> : null}
      </section>
      {facts.length > 0 ? (
        <section className="card">
          <h2>{title}</h2>
          {facts.map((fact) =>
            fact.kind === "text" ? (
              <Meta key={fact.label} label={fact.label} value={fact.value} />
            ) : fact.kind === "ports" ? (
              <p key={fact.label} className="wrap">
                <span className="muted">{fact.label} </span>
                {fact.ports.map((item, index) => (
                  <span key={`${item.label}-${index}`}>
                    {index > 0 ? ", " : null}
                    {item.proto === "TCP" && onServicePort ? (
                      <button type="button" className="port" onClick={() => onServicePort(item.port)}>
                        {item.label}
                      </button>
                    ) : (
                      item.label
                    )}
                  </span>
                ))}
              </p>
            ) : fact.kind === "table" ? (
              <div key={fact.label} className="fact-block">
                <p className="muted">{fact.label}</p>
                <FactTable columns={fact.columns} rows={fact.rows} />
              </div>
            ) : (
              <div key={fact.label} className="fact-block">
                <p className="muted">{fact.label}</p>
                <ul className="fact-list">
                  {fact.items.map((item, index) => (
                    <li key={`${item}-${index}`} className="wrap">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </section>
      ) : null}
      {kind === "pods" ? <ContainersCard ready={containersReady} containers={containers} /> : null}
      <PairFold title="Labels" pairs={row.labels} />
      <PairFold title="Annotations" pairs={row.annotations} nowrapKey />
    </div>
  );
}

/** Spec facts and live status of every container, right after the pods facts card. */
function ContainersCard({ ready, containers }: { ready: boolean; containers: PodContainer[] | null }) {
  return (
    <section className="card">
      <h2>
        Containers
        {containers ? <span className="muted"> {containers.length}</span> : null}
      </h2>
      {!ready || containers == null ? <p className="muted">Loading containers…</p> : null}
      {ready && containers?.length === 0 ? <p className="muted">none</p> : null}
      {containers?.map((container, index) => (
        <ContainerBlock container={container} key={`${container.name}-${index}`} />
      ))}
    </section>
  );
}

/** Text color of the container state; the label itself stays readable either way. */
function stateColor(state: string, ready: boolean): string {
  if (state === "Running") return ready ? "var(--ok)" : "var(--warn)";
  if (state.startsWith("Waiting") || state.startsWith("Terminated")) return "var(--bad)";
  if (state === "Pending") return "var(--warn)";
  return "var(--muted)";
}

function ContainerBlock({ container }: { container: PodContainer }) {
  const color = stateColor(container.state, container.ready);
  return (
    <div className="container-block">
      <div className="container-head">
        <span className="container-name">{container.name}</span>
        {container.init ? <span className="badge">init</span> : null}
        <span className="container-state" style={{ color }}>
          <i className="dot" style={{ background: color }} />
          {container.state}
        </span>
        <span className="spacer" />
        {container.restarts > 0 ? (
          <span className="badge warn" title={`${container.restarts} restarts`}>
            ×{container.restarts}
          </span>
        ) : null}
      </div>
      <p className="container-fact wrap">
        <span className="field-label">Image</span>
        {container.image || "—"}
      </p>
      <div className="container-fact port-row">
        <span className="field-label">Ports</span>
        {container.ports.length > 0 ? (
          <div className="port-list">
            {container.ports.map((port) => (
              <span key={port}>{port}</span>
            ))}
          </div>
        ) : (
          <span>—</span>
        )}
      </div>
      <ResourcesTable requests={container.requests} limits={container.limits} />
      {container.env.length > 0 ? (
        <details className="container-fold">
          <summary>
            Environment <span className="muted">{container.env.length}</span>
          </summary>
          <EnvGroups env={container.env} />
        </details>
      ) : null}
      {container.mounts.length > 0 ? (
        <details className="container-fold">
          <summary>
            Mounts <span className="muted">{container.mounts.length}</span>
          </summary>
          <FactTable
            columns={["Path", "Source"]}
            rows={container.mounts.map((item) => [item.path, mountLabel(item)])}
            nowrapFirst
          />
        </details>
      ) : null}
    </div>
  );
}

/** Requests and limits as one table: rows are requests/limits, columns are resources. */
function ResourcesTable({
  requests,
  limits,
}: {
  requests: Record<string, string>;
  limits: Record<string, string>;
}) {
  const resources = [...new Set([...Object.keys(requests), ...Object.keys(limits)])].sort();
  if (resources.length === 0) return null;
  return (
    <div className="table-scroll">
      <table className="detail-table resources-table">
        <thead>
          <tr>
            <th aria-hidden="true" />
            {resources.map((resource) => (
              <th key={resource}>{resource}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(["requests", "limits"] as const).map((row) => (
            <tr key={row}>
              <td className="field-label nowrap">{row}</td>
              {resources.map((resource) => (
                <td key={resource}>{row === "requests" ? requests[resource] ?? "—" : limits[resource] ?? "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One value that may be a Secret payload: it stays hidden behind dots until the
 * eye of that single value is clicked, so no global switch is needed. */
function SecretValue({ value, masked }: { value: string; masked: boolean }) {
  const [shown, setShown] = useState(!masked);
  useEffect(() => {
    setShown(!masked);
  }, [masked]);
  return (
    <span className="env-value">
      <span className="wrap">{shown && value ? previewValue(value) : masked ? "••••••" : "—"}</span>
      {masked ? (
        <IconButton label={shown ? "Hide value" : "Show value"} onClick={() => setShown((open) => !open)}>
          <EyeIcon />
        </IconButton>
      ) : null}
      {value ? (
        <IconButton label="Copy" onClick={() => void navigator.clipboard.writeText(value)}>
          <CopyIcon />
        </IconButton>
      ) : null}
    </span>
  );
}

/** Env values of one container, grouped by where they come from: a small
 * origin heading over each two-column name/value table. */
function EnvGroups({ env }: { env: PodEnv[] }) {
  const groups = new Map<string, PodEnv[]>();
  for (const item of env) {
    const origin = envOrigin(item);
    const list = groups.get(origin);
    if (list) list.push(item);
    else groups.set(origin, [item]);
  }
  return (
    <div>
      {[...groups].map(([origin, items]) => (
        <div className="env-group" key={origin}>
          <p className="env-origin">{origin}</p>
          <div className="table-scroll">
            <table className="detail-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={`${item.name}-${index}`}>
                    <td className="nowrap">{item.name}</td>
                    <td className="wrap">
                      <span className="cell">
                        <SecretValue value={item.value} masked={item.masked} />
                        {item.note ? <span className="muted"> {item.note}</span> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Where an env value comes from, with the key when it differs from the name. */
function envOrigin(env: PodEnv): string {
  return env.key != null && !env.name.endsWith(env.key) ? `${env.origin}:${env.key}` : env.origin;
}

function mountLabel(mount: PodMount): string {
  const parts = [mount.source, `volume ${mount.name}`];
  if (mount.subPath) parts.push(`subPath ${mount.subPath}`);
  if (mount.readOnly) parts.push("ro");
  if (mount.note) parts.push(mount.note);
  return parts.join(" · ");
}

function PairFold({ title, pairs, nowrapKey = false }: { title: string; pairs: [string, string][]; nowrapKey?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="card">
      <button className="fold" onClick={() => setOpen((value) => !value)}>
        <i className={open ? "chevron" : "chevron closed"} />
        <span>{title}</span>
        <span className="muted">{pairs.length}</span>
      </button>
      {open ? (
        pairs.length === 0 ? (
          <p className="muted">none</p>
        ) : (
          <FactTable columns={["Key", "Value"]} rows={pairs} nowrapFirst={nowrapKey} />
        )
      ) : null}
    </section>
  );
}

type ServicePort = { label: string; port: number; proto: string };

type Fact =
  | { kind: "text"; label: string; value: string }
  | { kind: "list"; label: string; items: string[] }
  | { kind: "table"; label: string; columns: string[]; rows: string[][] }
  | { kind: "ports"; label: string; ports: ServicePort[] };

const LISTENER_COLUMNS = ["Name", "Protocol", "Port", "Hostname"];

function FactTable({
  columns,
  rows,
  nowrapFirst = false,
}: {
  columns: string[];
  rows: ReactNode[][];
  nowrapFirst?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className="detail-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column, columnIndex) => (
                <td key={column} className={nowrapFirst && columnIndex === 0 ? "nowrap" : "wrap"}>
                  <span className="cell">{row[columnIndex] ?? ""}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shown(value: string | undefined): boolean {
  return value != null && value !== "" && value !== "-";
}

function textFact(label: string, value: string): Fact | null {
  if (!shown(value)) return null;
  return { kind: "text", label, value };
}

function listFact(label: string, raw: string, split: string): Fact | null {
  const items = raw
    .split(split)
    .map((item) => item.trim())
    .filter((item) => shown(item));
  if (items.length === 0) return null;
  return { kind: "list", label, items };
}

function portsFact(raw: string): Fact | null {
  const ports = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => shown(item))
    .flatMap((label) => {
      const slash = label.lastIndexOf("/");
      const number = Number(slash < 0 ? label : label.slice(0, slash));
      const proto = (slash < 0 ? "TCP" : label.slice(slash + 1)).toUpperCase();
      if (!Number.isInteger(number) || number < 1 || number > 65535) return [];
      return [{ label, port: number, proto }];
    });
  if (ports.length === 0) return null;
  return { kind: "ports", label: "Ports", ports };
}

function tableFact(label: string, raw: string, columns: string[]): Fact | null {
  const rows = raw
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((row) => row.some((item) => shown(item)));
  if (rows.length === 0) return null;
  return { kind: "table", label, columns, rows };
}

function keep(facts: Array<Fact | null>): Fact[] {
  return facts.filter((fact): fact is Fact => fact != null);
}

function cell(row: ResourceRow, key: string): string {
  return row.cells[key] ?? "";
}

function resourceFacts(kind: ResourceKind | null, row: ResourceRow): Fact[] {
  const cpu = formatCpuPair(row.cpuMillis, row.cpuRequestMillis);
  const memory = formatBytesPair(row.memBytes, row.memRequestBytes);
  switch (kind) {
    case "pods":
      return keep([
        textFact("Node", cell(row, "node")),
        textFact("IP", cell(row, "podIP")),
        textFact("QoS", cell(row, "qos")),
        textFact("Restarts", cell(row, "restarts")),
        textFact("CPU", cpu),
        textFact("Memory", memory),
        listFact("Images", cell(row, "images"), "\n"),
      ]);
    case "deployments":
      return keep([
        textFact("Updated", cell(row, "updated")),
        textFact("Available", cell(row, "available")),
        textFact("Unavailable", cell(row, "unavailable")),
        textFact("Strategy", cell(row, "strategy")),
        listFact("Images", cell(row, "images"), "\n"),
      ]);
    case "replicaSets":
      return keep([listFact("Images", cell(row, "images"), "\n")]);
    case "statefulSets":
      return keep([
        textFact("Current", cell(row, "current")),
        textFact("Updated", cell(row, "updated")),
        textFact("Service", cell(row, "service")),
        textFact("Pod management", cell(row, "podManagement")),
        listFact("Images", cell(row, "images"), "\n"),
      ]);
    case "daemonSets":
      return keep([
        textFact("Current", cell(row, "current")),
        textFact("Updated", cell(row, "updated")),
        textFact("Available", cell(row, "available")),
        textFact("Misscheduled", cell(row, "misscheduled")),
        listFact("Images", cell(row, "images"), "\n"),
      ]);
    case "jobs":
      return keep([
        textFact("Completions", row.ready),
        textFact("Failed", row.info),
        textFact("Parallelism", cell(row, "parallelism")),
        textFact("Backoff", cell(row, "backoff")),
        listFact("Images", cell(row, "images"), "\n"),
      ]);
    case "cronJobs":
      return keep([
        textFact("Schedule", row.info),
        textFact("Suspend", row.status),
        textFact("Active", row.ready),
        textFact("Concurrency", cell(row, "concurrency")),
        textFact("Last schedule", cell(row, "lastSchedule")),
        listFact("Images", cell(row, "images"), "\n"),
      ]);
    case "services":
      return keep([
        textFact("Type", row.status),
        textFact("Cluster IP", row.ready),
        textFact("External IP", cell(row, "externalIP")),
        textFact("Selector", cell(row, "selector")),
        portsFact(row.info),
      ]);
    case "ingresses":
      return keep([
        textFact("Class", row.ready),
        textFact("Hosts", row.info),
        listFact("Addresses", cell(row, "addresses"), "\n"),
        listFact("TLS", cell(row, "tls"), "\n"),
      ]);
    case "gateways":
      return keep([
        textFact("Class", cell(row, "class")),
        listFact("Addresses", cell(row, "addresses"), ","),
        tableFact("Listeners", cell(row, "listenerList"), LISTENER_COLUMNS),
      ]);
    case "httpRoutes":
    case "grpcRoutes":
    case "tlsRoutes":
      return keep([textFact("Hostnames", cell(row, "hostnames")), textFact("Parent", cell(row, "parent"))]);
    case "tcpRoutes":
    case "udpRoutes":
      return keep([textFact("Parent", cell(row, "parent")), textFact("Backends", cell(row, "backends"))]);
    case "listenerSets":
      return keep([
        textFact("Gateway", cell(row, "gateway")),
        tableFact("Listeners", cell(row, "listenerList"), LISTENER_COLUMNS),
      ]);
    case "backendTLSPolicies":
      return keep([textFact("Target", cell(row, "target")), textFact("Hostname", cell(row, "hostname"))]);
    case "referenceGrants":
      return keep([textFact("From", cell(row, "from")), textFact("To", cell(row, "to"))]);
    case "nodes":
      return keep([
        textFact("Roles", row.info),
        textFact("Kubelet", row.ready),
        textFact("Internal IP", cell(row, "internalIP")),
        textFact("OS", cell(row, "os")),
        textFact("Runtime", cell(row, "runtime")),
        textFact("Pods", cell(row, "pods")),
        textFact("CPU", cpu),
        textFact("Memory", memory),
      ]);
    case "configMaps":
      return keep([textFact("Keys", row.ready), listFact("Data", cell(row, "keyList"), "\n")]);
    case "secrets":
      return keep([
        textFact("Type", row.status),
        textFact("Keys", row.ready),
        listFact("Data", cell(row, "keyList"), "\n"),
      ]);
    case "persistentVolumeClaims":
      return keep([
        textFact("Phase", row.status),
        textFact("Size", row.ready),
        textFact("Class", cell(row, "class")),
        textFact("Volume", cell(row, "volume")),
        textFact("Access modes", cell(row, "accessModes")),
      ]);
    case "persistentVolumes":
      return keep([
        textFact("Phase", row.status),
        textFact("Size", row.ready),
        textFact("Class", cell(row, "class")),
        textFact("Reclaim", cell(row, "reclaim")),
        textFact("Claim", cell(row, "claim")),
        textFact("Access modes", cell(row, "accessModes")),
      ]);
    case "storageClasses":
      return keep([
        textFact("Provisioner", row.info),
        textFact("Reclaim", row.ready),
        textFact("Binding", cell(row, "binding")),
        textFact("Expansion", cell(row, "expansion")),
      ]);
    case "serviceAccounts":
      return keep([
        textFact("Secrets", row.ready),
        textFact("Pull secrets", row.info),
        listFact("Secret names", cell(row, "secretNames"), "\n"),
        listFact("Pull secret names", cell(row, "pullNames"), "\n"),
      ]);
    case "roles":
    case "clusterRoles":
      return keep([textFact("Rules", row.ready), listFact("Rule list", cell(row, "ruleList"), "\n")]);
    case "roleBindings":
    case "clusterRoleBindings":
      return keep([
        textFact("Subjects", row.ready),
        textFact("Role", row.info),
        listFact("Subject names", cell(row, "subjectList"), "\n"),
      ]);
    case "namespaces":
      return keep([textFact("Phase", row.status)]);
    case "events":
      return keep([
        textFact("Type", cell(row, "type")),
        textFact("Reason", cell(row, "reason")),
        textFact("Object", cell(row, "object")),
        textFact("Source", cell(row, "source")),
        textFact("Count", cell(row, "count")),
        textFact("Last seen", cell(row, "lastSeen")),
        textFact("Message", cell(row, "message")),
      ]);
    case "horizontalPodAutoscalers":
      return keep([
        textFact("Replicas", row.ready),
        textFact("Target", row.info),
        textFact("Min", cell(row, "min")),
        textFact("Max", cell(row, "max")),
      ]);
    case "podDisruptionBudgets":
      return keep([
        textFact("Healthy", row.ready),
        textFact("Budget", row.info),
        textFact("Allowed", cell(row, "allowed")),
        textFact("Selector", cell(row, "selector")),
      ]);
    case "networkPolicies":
      return keep([
        textFact("Types", row.ready),
        textFact("Rules", row.info),
        textFact("Selector", cell(row, "selector")),
      ]);
    case "resourceQuotas":
      return keep([textFact("Used", row.ready), textFact("Hard", row.info)]);
    case "limitRanges":
      return keep([textFact("Limits", row.ready), textFact("Types", row.info)]);
    case "endpoints":
      return keep([
        textFact("Addresses", row.ready),
        textFact("Not ready", row.info),
        listFact("Ports", cell(row, "ports"), "\n"),
      ]);
    case "endpointSlices":
      return keep([
        textFact("Address type", row.status),
        textFact("Endpoints", row.ready),
        listFact("Ports", cell(row, "ports"), "\n"),
      ]);
    case "customResourceDefinitions":
      return keep([
        textFact("Scope", row.ready),
        textFact("Group", row.info),
        textFact("Kind", cell(row, "kind")),
        textFact("Versions", cell(row, "versions")),
      ]);
    case "gatewayClasses":
    case "ingressClasses":
      return keep([textFact("Controller", kind === "gatewayClasses" ? cell(row, "controller") : row.ready)]);
    default:
      return keep([
        textFact("Info", row.info),
        ...Object.entries(row.cells)
          .filter(([key]) => key !== "managedBy" && key !== "controlledBy")
          .map(([key, value]) => textFact(key, value)),
      ]);
  }
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <p className="wrap">
      <span className="muted">{label} </span>
      {value}
    </p>
  );
}

function YamlTab({ kubi, secret, ready, yaml }: { kubi: Kubi; secret: boolean; ready: boolean; yaml: string | null }) {
  const reveal = kubi.activeTab?.reveal ?? false;
  const uid = kubi.activeTab?.selected ?? "";
  const [draft, setDraft] = useState(yaml ?? "");
  useEffect(() => {
    setDraft(yaml ?? "");
  }, [uid, yaml]);
  const masked = secret && !reveal;
  return (
    <div className="yaml-tab">
      {secret ? (
        <label className="row">
          <input type="checkbox" checked={reveal} onChange={(event) => kubi.setReveal(event.target.checked)} /> Show
          secret values
        </label>
      ) : null}
      {!ready || yaml == null ? <p>Loading YAML…</p> : null}
      {ready && yaml != null ? (
        <>
          <div className="row">
            <IconButton label="Copy" onClick={() => void navigator.clipboard.writeText(draft)}>
              <CopyIcon />
            </IconButton>
            <IconButton
              label="Patch"
              disabled={masked || draft.trim() === ""}
              onClick={() => kubi.patchYaml(draft)}
            >
              <CheckIcon />
            </IconButton>
            {masked ? <span className="muted">Show secret values before patching.</span> : null}
          </div>
          {kubi.patchError ? <p className="bad wrap">{kubi.patchError}</p> : null}
          <YamlEditor value={draft} onChange={setDraft} />
        </>
      ) : null}
    </div>
  );
}

function DataTab({
  kubi,
  secret,
  ready,
  entries,
}: {
  kubi: Kubi;
  secret: boolean;
  ready: boolean;
  entries: DataEntry[] | null;
}) {
  const uid = kubi.activeTab?.selected ?? "";
  const [shown, setShown] = useState<string[]>([]);
  useEffect(() => {
    setShown([]);
  }, [uid]);
  return (
    <div>
      {!ready ? <p>Loading values…</p> : null}
      {ready && entries == null ? <p className="muted">No values.</p> : null}
      {ready && entries?.length === 0 ? <p className="muted">No keys.</p> : null}
      {entries?.map((entry) => {
        const open = !secret || shown.includes(entry.key);
        const shownText = open ? previewValue(entry.value) : "••••••";
        return (
          <div key={entry.key} className="entry">
            <div className="entry-head">
              <span className="key wrap">{entry.key}</span>
              {secret ? (
                <IconButton
                  label={open ? "Hide value" : "Show value"}
                  onClick={() =>
                    setShown((keys) => (keys.includes(entry.key) ? keys.filter((key) => key !== entry.key) : [...keys, entry.key]))
                  }
                >
                  <EyeIcon />
                </IconButton>
              ) : null}
              <IconButton label="Copy" onClick={() => void navigator.clipboard.writeText(entry.value)}>
                <CopyIcon />
              </IconButton>
            </div>
            <div className="wrap">{shownText}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Mounts and environment of the selected pod, with ConfigMap and Secret values resolved. */
function SourcesTab({
  ready,
  sources,
}: {
  ready: boolean;
  sources: PodSources | null;
}) {
  if (!ready || sources == null) return <p className="muted">Loading sources…</p>;
  const containers: string[] = [];
  for (const item of [...sources.env, ...sources.mounts]) {
    if (!containers.includes(item.container)) containers.push(item.container);
  }
  if (containers.length === 0) return <p className="muted">No environment or mounts.</p>;
  return (
    <div className="detail-stack">
      {containers.map((container) => {
        const env = sources.env.filter((item) => item.container === container);
        const mounts = sources.mounts.filter((item) => item.container === container);
        return (
          <section className="card" key={container}>
            <h2>{container}</h2>
            {env.length > 0 ? (
              <div className="fact-block">
                <p className="muted">Environment</p>
                {env.map((item, index) => (
                  <EnvEntry env={item} key={`${item.name}-${index}`} />
                ))}
              </div>
            ) : null}
            {mounts.length > 0 ? (
              <div className="fact-block">
                <p className="muted">Mounts</p>
                {mounts.map((item, index) => (
                  <MountEntry mount={item} key={`${item.name}-${item.path}-${index}`} />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function EnvEntry({ env }: { env: PodEnv }) {
  return (
    <div className="entry">
      <div className="entry-head">
        <span className="key wrap">{env.name}</span>
        <span className="muted wrap">{envOrigin(env)}</span>
      </div>
      <SecretValue value={env.value} masked={env.masked} />
      {env.note ? <p className="muted wrap">{env.note}</p> : null}
    </div>
  );
}

function MountEntry({ mount }: { mount: PodMount }) {
  return (
    <div className="entry">
      <div className="entry-head">
        <span className="key wrap">{mount.path}</span>
        <span className="muted wrap">{mount.source}</span>
        {mount.readOnly ? <span className="badge">ro</span> : null}
      </div>
      <div className="muted wrap">
        volume {mount.name}
        {mount.subPath ? ` · subPath ${mount.subPath}` : ""}
      </div>
      {mount.values.length > 0 ? (
        <FactTable
          columns={["Key", "Value"]}
          rows={mount.values.map((value) => [value.key, <SecretValue value={value.value} masked={value.masked} />])}
        />
      ) : null}
      {mount.note ? <p className="muted wrap">{mount.note}</p> : null}
    </div>
  );
}

function EventRow({ event, showType = true }: { event: EventInfo; showType?: boolean }) {
  return (
    <div className="event">
      <div className="event-head">
        {showType ? (
          <span className={event.kind === "Warning" ? "type warn" : "type normal"}>{event.kind}</span>
        ) : null}
        <span className="key wrap">{event.reason || "—"}</span>
        {event.count > 1 ? <span className="muted">×{event.count}</span> : null}
        <span className="spacer" />
        <span className="muted">{event.ageSecs == null ? "—" : formatAge(event.ageSecs)}</span>
      </div>
      <p className="message">{event.message || "—"}</p>
      {event.source ? <p className="source">{event.source}</p> : null}
    </div>
  );
}

function EventsTab({
  ready,
  events,
  hidden,
}: {
  ready: boolean;
  events: EventInfo[] | null;
  hidden: number;
}) {
  if (!ready || events == null) return <p className="muted">Loading events…</p>;
  return (
    <div>
      {events.length === 0 ? (
        <p className="muted">No events for this object.</p>
      ) : (
        events.map((event, index) => (
          <EventRow event={event} key={`${event.reason}-${event.ageSecs ?? "?"}-${index}`} />
        ))
      )}
      {hidden > 0 ? (
        <p className="muted">
          {hidden} probe warning{hidden === 1 ? "" : "s"} hidden — the pod is running.
        </p>
      ) : null}
    </div>
  );
}

function Metrics({ kubi, row }: { kubi: Kubi; row: ResourceRow }) {
  return (
    <div>
      {kubi.metricsNote ? <p>{kubi.metricsNote}</p> : null}
      <p>
        CPU {formatCpuPair(row.cpuMillis, row.cpuRequestMillis)} Memory {formatBytesPair(row.memBytes, row.memRequestBytes)}
      </p>
      {kubi.history.length === 0 ? <p className="muted">Waiting for metrics samples…</p> : null}
      {kubi.history.length > 0 ? (
        <>
          <p className="muted">CPU (millicores)</p>
          <Chart points={kubi.history.map((point) => point.cpu)} color="#4c8dff" />
          <p className="muted">Memory (MiB)</p>
          <Chart points={kubi.history.map((point) => point.mem / (1024 * 1024))} color="#3fb950" />
          <p className="muted">CPU is usage versus requests. For nodes the second number is allocatable.</p>
        </>
      ) : null}
    </div>
  );
}

function Chart({ points, color }: { points: number[]; color: string }) {
  const width = 360;
  const height = 120;
  const max = Math.max(...points, 1);
  const path = points
    .map((value, index) => {
      const x = points.length === 1 ? 0 : (index / (points.length - 1)) * width;
      const y = height - (value / max) * (height - 8) - 4;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img">
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function SearchModal({ kubi }: { kubi: Kubi }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [step, setStep] = useState(0);
  const hits = searchHits(query, kubi.customResources, kubi.namespaces);
  const plan = planSearch(query, kubi.customResources, kubi.namespaces);
  const preferred = kubi.activeTab?.namespace ?? null;
  const suggestions = namespaceSuggestions(plan, kubi.namespaces, preferred);
  // The namespace the query points at: resolved outright, or the highlighted
  // suggestion while the fragment still matches several.
  const active =
    plan.namespace ??
    (plan.namespaceSlot && suggestions.length > 0 ? suggestions[step % suggestions.length] : null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const safe = hits.length === 0 ? 0 : cursor % hits.length;
  const open = (hit: SearchHit) => {
    // The namespace shown under the field wins; with none in play the view keeps
    // the namespace it opens from.
    const namespace = viewAcceptsNamespace(hit.view) ? (hit.namespace ?? active) : null;
    kubi.openView(hit.view, namespace ?? undefined);
    kubi.setSearchOpen(false);
  };
  /** Hits carry the typed fragment; show the namespace Enter would use instead. */
  const hintOf = (hit: SearchHit): string => {
    if (active == null || !viewAcceptsNamespace(hit.view)) return hit.hint;
    const group = hit.hint.split(" · ")[0];
    return group === "" ? active : `${group} · ${active}`;
  };
  const complete = () => {
    const next = completeSearch(
      query,
      kubi.customResources,
      kubi.namespaces,
      hits[safe]?.label ?? null,
      plan.namespaceSlot ? step : 0,
      preferred,
    );
    if (next == null) return;
    setQuery(next);
    setCursor(0);
    setStep(plan.namespaceSlot ? step + 1 : 0);
  };
  const chooseNamespace = (name: string) => {
    setQuery(`${plan.text} ${name}`);
    setCursor(0);
    setStep(0);
  };
  const letter = (event: { key: string }) => event.key.toLowerCase();
  const chord = (event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }) =>
    event.ctrlKey && !event.metaKey && !event.altKey;
  return (
    <div className="modal-back" onMouseDown={() => kubi.setSearchOpen(false)}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder="Search resources — try pods kube-system"
          aria-label="Search resources"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
            setStep(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") kubi.setSearchOpen(false);
            if (event.key === "Tab") {
              event.preventDefault();
              complete();
              return;
            }
            if (event.key === "ArrowDown" || (chord(event) && letter(event) === "n")) {
              setCursor((value) => value + 1);
              event.preventDefault();
            }
            if (event.key === "ArrowUp" || (chord(event) && letter(event) === "p")) {
              setCursor((value) => Math.max(0, value - 1));
              event.preventDefault();
            }
            if (event.key === "Enter" && hits[safe]) open(hits[safe]);
          }}
        />
        {suggestions.length > 0 && hits.some((hit) => viewAcceptsNamespace(hit.view)) ? (
          <div className="ns-hints">
            <span className="muted">{plan.namespaceSlot ? "Namespace ⇥" : "Namespace"}</span>
            {suggestions.slice(0, 8).map((name) => (
              <button key={name} className={name === active ? "on" : ""} onClick={() => chooseNamespace(name)}>
                {name}
              </button>
            ))}
            {suggestions.length > 8 ? <span className="muted">+{suggestions.length - 8}</span> : null}
          </div>
        ) : null}
        <div className="search-list">
          {hits.slice(0, 40).map((hit, index) => (
            <button
              key={`${hit.label}-${hit.hint}-${index}`}
              className={index === safe ? "on" : ""}
              onClick={() => open(hit)}
            >
              <span>{hit.label}</span>
              <span className="muted">{hintOf(hit)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CreateModal({ kubi }: { kubi: Kubi }) {
  return (
    <div className="modal-back">
      <div className="modal">
        <strong>Create</strong>
        <textarea value={kubi.createYaml} onChange={(event) => kubi.setCreateYaml(event.target.value)} spellCheck={false} />
        {kubi.createError ? <p className="bad wrap">{kubi.createError}</p> : null}
        <div className="row">
          <button onClick={kubi.closeCreate} disabled={kubi.createBusy}>
            Cancel
          </button>
          <button onClick={kubi.applyCreate} disabled={kubi.createBusy}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteModal({ kubi }: { kubi: Kubi }) {
  const pending = kubi.pendingDelete;
  if (!pending) return null;
  const names = pending.items.map((item) => (item.namespace ? `${item.namespace}/${item.name}` : item.name));
  return (
    <div className="modal-back">
      <div className="modal">
        {names.length === 1 ? (
          <p>
            Delete {pending.title} {names[0]}?
          </p>
        ) : (
          <>
            <p>
              Delete {names.length} {pending.title}?
            </p>
            <ul className="fact-list">
              {names.map((name) => (
                <li key={name} className="wrap">
                  {name}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="row">
          <button onClick={kubi.cancelDelete}>Cancel</button>
          <button className="bad" onClick={kubi.confirmDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function ForwardDialog({ kubi }: { kubi: Kubi }) {
  const draft = kubi.forwardDraft;
  if (!draft) return null;
  const place = draft.namespace ? `${draft.namespace}/${draft.name}` : draft.name;
  return (
    <div className="modal-back" onMouseDown={kubi.cancelForward}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <strong>Port forward {place}</strong>
        <label className="field">
          Remote port
          <input
            value={draft.remotePort}
            inputMode="numeric"
            onChange={(event) => kubi.setForwardPort("remotePort", event.target.value)}
          />
        </label>
        <label className="field">
          Local port
          <input
            value={draft.localPort}
            inputMode="numeric"
            onChange={(event) => kubi.setForwardPort("localPort", event.target.value)}
          />
        </label>
        <div className="row">
          <button onClick={kubi.cancelForward}>Cancel</button>
          <button onClick={kubi.confirmForward}>Start</button>
        </div>
      </div>
    </div>
  );
}

export function ForwardBar({ kubi }: { kubi: Kubi }) {
  if (kubi.forwards.length === 0) return null;
  return (
    <div className="forward-bar">
      {kubi.forwards.map((item) => (
        <span key={item.id} className="forward">
          <span>
            {item.localPort} → {item.namespace ? `${item.namespace}/` : ""}
            {item.name}:{item.remotePort}
          </span>
          <button aria-label={`Stop forward ${item.name}`} onClick={() => kubi.stopForward(item.id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

