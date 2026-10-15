import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { readGroupsFile, writeGroupsFile } from "./api";
import { CLUSTER_COLORS, clusterColor, initials } from "./format";
import type { ContextGroup, ContextInfo } from "./types";
import type { Kubi } from "./useKubi";

/** Gap between two context rows, matching `.items { gap }` in the stylesheet. */
const ROW_GAP = 2;
/** Pixels of movement before a press turns into a drag. */
const DRAG_SLOP = 4;

export type ContextLayout = {
  groups: ContextGroup[];
  /** Order of the contexts that are in no folder. */
  loose: string[];
};

export function newGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function strings(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value === "string" && value !== "") seen.add(value);
  }
  return [...seen];
}

/**
 * Reads the stored layout, dropping anything malformed. Context names are kept
 * even when the current kubeconfig does not have them, so switching kubeconfigs
 * back and forth is lossless.
 */
export function parseLayout(text: string | null): ContextLayout {
  if (text == null || text.trim() === "") return { groups: [], loose: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { groups: [], loose: [] };
  }
  const root: unknown = Array.isArray(raw) ? { groups: raw } : raw;
  const list =
    root != null && typeof root === "object" && Array.isArray((root as { groups?: unknown }).groups)
      ? ((root as { groups: unknown[] }).groups)
      : [];
  const groups: ContextGroup[] = [];
  const names = new Set<string>();
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") continue;
    const item = entry as { id?: unknown; name?: unknown; contexts?: unknown };
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name === "" || names.has(name)) continue;
    names.add(name);
    groups.push({
      id: typeof item.id === "string" && item.id !== "" ? item.id : newGroupId(),
      name,
      contexts: strings(item.contexts),
    });
  }
  const loose =
    root != null && typeof root === "object" ? strings((root as { loose?: unknown }).loose) : [];
  return { groups, loose };
}

export function serializeLayout(layout: ContextLayout): string {
  return JSON.stringify({ version: 2, groups: layout.groups, loose: layout.loose }, null, 2);
}

/** Folder rows with their live contexts, plus the contexts no folder claims. */
export function partitionContexts(
  layout: ContextLayout,
  contexts: ContextInfo[],
): { rows: { group: ContextGroup; items: ContextInfo[] }[]; loose: ContextInfo[] } {
  const byName = new Map(contexts.map((item) => [item.name, item]));
  const claimed = new Set<string>();
  const rows = layout.groups.map((group) => {
    const items: ContextInfo[] = [];
    for (const name of group.contexts) {
      const item = byName.get(name);
      if (item == null || claimed.has(name)) continue;
      claimed.add(name);
      items.push(item);
    }
    return { group, items };
  });
  const loose: ContextInfo[] = [];
  const seen = new Set(claimed);
  for (const name of [...layout.loose, ...contexts.map((item) => item.name)]) {
    const item = byName.get(name);
    if (item == null || seen.has(name)) continue;
    seen.add(name);
    loose.push(item);
  }
  return { rows, loose };
}

/** Materialises the visible order, keeping names the kubeconfig does not have. */
export function normalizeLayout(layout: ContextLayout, contexts: ContextInfo[]): ContextLayout {
  const { rows, loose } = partitionContexts(layout, contexts);
  const known = new Set([...rows.flatMap((row) => row.group.contexts), ...loose.map((item) => item.name)]);
  const strays = layout.loose.filter((name) => !known.has(name));
  return { groups: layout.groups, loose: [...loose.map((item) => item.name), ...strays] };
}

export function renameGroup(groups: ContextGroup[], id: string, name: string): ContextGroup[] {
  const trimmed = name.trim();
  if (trimmed === "") return groups;
  return groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group));
}

export function dropGroup(groups: ContextGroup[], id: string): ContextGroup[] {
  return groups.filter((group) => group.id !== id);
}

/**
 * Moves a context into `zone` (`""` = no folder) at `index`, or to the end when
 * the index is null. Names it leaves behind keep their relative order.
 */
export function moveContext(
  layout: ContextLayout,
  token: string,
  zone: string | null,
  index: number | null,
): ContextLayout {
  const groups = layout.groups.map((group) => ({
    ...group,
    contexts: group.contexts.filter((name) => name !== token),
  }));
  const loose = layout.loose.filter((name) => name !== token);
  const insert = (list: string[]): string[] => {
    const at = index == null ? list.length : Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), token, ...list.slice(at)];
  };
  if (zone == null) return { groups, loose };
  if (zone === "") return { groups, loose: insert(loose) };
  return {
    groups: groups.map((group) =>
      group.id === zone ? { ...group, contexts: insert(group.contexts) } : group,
    ),
    loose,
  };
}

type ZoneRows = {
  zone: string;
  step: number;
  rows: { name: string; index: number; mid: number; top: number; height: number }[];
};

type DragLive = {
  token: string;
  fromZone: string;
  fromIndex: number;
  /** Row pitch of the source list, used for the shift animation. */
  step: number;
  /** Target zone, `""` for the ungrouped area, null when nowhere. */
  zone: string | null;
  /** Insertion index in the target list once the dragged row is removed. */
  index: number | null;
  left: number;
  top: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
};

type DragDrop = { token: string; zone: string; index: number | null };

function readZones(): ZoneRows[] {
  return [...document.querySelectorAll<HTMLElement>("[data-list]")].map((list) => {
    const rows = [...list.querySelectorAll<HTMLElement>("[data-ctx]")].map((row, index) => {
      const rect = row.getBoundingClientRect();
      return {
        name: row.getAttribute("data-ctx") ?? "",
        index,
        mid: rect.top + rect.height / 2,
        top: rect.top,
        height: rect.height,
      };
    });
    return {
      zone: list.getAttribute("data-list") ?? "",
      rows,
      step: rows.length > 1 ? rows[1].top - rows[0].top : (rows[0]?.height ?? 0) + ROW_GAP,
    };
  });
}

function shiftFor(index: number, from: number, over: number, unit: number): number {
  if (index === from) return 0;
  if (from < over && index > from && index <= over) return -unit;
  if (over < from && index < from && index >= over) return unit;
  return 0;
}

/** Rows make room while dragging; the row itself rides along as a ghost. */
export function rowMotion(
  zone: string,
  index: number,
  name: string,
  live: DragLive | null,
): { className: string; style?: CSSProperties } {
  if (live == null) return { className: "" };
  const within = live.zone === live.fromZone;
  if (live.token === name) {
    if (!within) return { className: "held" };
    return { className: "dragging", style: { visibility: "hidden" } };
  }
  if (!within || live.zone !== zone || live.index == null) return { className: "" };
  const shift = shiftFor(index, live.fromIndex, live.index, live.step);
  if (shift === 0) return { className: "" };
  return { className: "shift", style: { transform: `translateY(${shift}px)` } };
}

/** Pointer drag: HTML5 drag events are unreliable inside the webview. */
function useContextDrag() {
  const drag = useRef<{
    token: string;
    fromZone: string;
    fromIndex: number;
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
    dx: number;
    dy: number;
    moved: boolean;
    zone: string | null;
    index: number | null;
    zones: ZoneRows[];
  } | null>(null);
  const skipClick = useRef(false);
  const [live, setLive] = useState<DragLive | null>(null);

  return {
    live,
    dragging: live != null,
    zone: live?.zone ?? null,
    down(token: string, zone: string, index: number, event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const zones = readZones();
      skipClick.current = false;
      drag.current = {
        token,
        fromZone: zone,
        fromIndex: index,
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        dx: 0,
        dy: 0,
        moved: false,
        zone: null,
        index: null,
        zones,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    move(event: ReactPointerEvent<HTMLElement>) {
      const state = drag.current;
      if (state == null) return;
      state.dx = event.clientX - state.x;
      state.dy = event.clientY - state.y;
      if (!state.moved) {
        if (Math.hypot(state.dx, state.dy) <= DRAG_SLOP) return;
        state.moved = true;
      }
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const host = under instanceof Element ? under.closest("[data-drop]") : null;
      const zone = host?.getAttribute("data-drop") ?? null;
      const slots = state.zones.find((entry) => entry.zone === zone);
      let index: number | null = null;
      if (slots != null) {
        // Count the rows above the pointer, then drop the dragged row from the count.
        let raw = slots.rows.filter((row) => row.mid < event.clientY).length;
        if (zone === state.fromZone && raw > state.fromIndex) raw -= 1;
        index = raw;
      }
      state.zone = zone;
      state.index = index;
      const source = state.zones.find((entry) => entry.zone === state.fromZone);
      setLive({
        token: state.token,
        fromZone: state.fromZone,
        fromIndex: state.fromIndex,
        step: source?.step ?? state.height + ROW_GAP,
        zone,
        index,
        left: state.left,
        top: state.top,
        width: state.width,
        height: state.height,
        dx: state.dx,
        dy: state.dy,
      });
    },
    up(): DragDrop | null {
      const state = drag.current;
      drag.current = null;
      setLive(null);
      if (state == null || !state.moved) return null;
      skipClick.current = true;
      if (state.zone == null) return null;
      return { token: state.token, zone: state.zone, index: state.index };
    },
    cancel() {
      drag.current = null;
      setLive(null);
    },
    /** True when the click that follows belongs to a drag and must be swallowed. */
    swallow(): boolean {
      if (!skipClick.current) return false;
      skipClick.current = false;
      return true;
    },
  };
}

export function ContextRail({ kubi }: { kubi: Kubi }) {
  const [layout, setLayout] = useState<ContextLayout>({ groups: [], loose: [] });
  const [draft, setDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [closed, setClosed] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const drag = useContextDrag();

  useEffect(() => {
    let stop = false;
    void readGroupsFile()
      .then((text) => {
        if (!stop) setLayout(parseLayout(text));
      })
      .catch(() => {
        if (!stop) setNote("Folders could not be read");
      });
    return () => {
      stop = true;
    };
  }, []);

  function commit(next: ContextLayout) {
    const tidy = normalizeLayout(next, kubi.contexts);
    setLayout(tidy);
    void writeGroupsFile(serializeLayout(tidy)).catch(() => setNote("Folders could not be saved"));
  }

  function addFolder(name: string) {
    const trimmed = name.trim();
    if (trimmed === "") {
      setDraft(null);
      return;
    }
    if (layout.groups.some((group) => group.name === trimmed)) {
      setNote(`"${trimmed}" already exists`);
      return;
    }
    setNote(null);
    commit({ ...layout, groups: [...layout.groups, { id: newGroupId(), name: trimmed, contexts: [] }] });
    setDraft(null);
  }

  function finishRename() {
    if (renaming == null) return;
    const trimmed = renaming.value.trim();
    if (trimmed === "" || layout.groups.some((group) => group.name === trimmed && group.id !== renaming.id)) {
      setNote(trimmed === "" ? null : `"${trimmed}" already exists`);
      setRenaming(null);
      return;
    }
    setNote(null);
    commit({ ...layout, groups: renameGroup(layout.groups, renaming.id, trimmed) });
    setRenaming(null);
  }

  const { rows, loose } = partitionContexts(layout, kubi.contexts);
  const blocks = rows.filter((row) => row.items.length > 0).map((row) => row.items);
  if (loose.length > 0) blocks.push(loose);
  const strip = blocks.flat();
  /** Contexts with tabs open in this window, so the rail shows where work lives. */
  const openTabs = new Set(kubi.tabs.map((tab) => tab.context));

  function chip(item: ContextInfo) {
    return (
      <button
        key={item.name}
        className={item.name === kubi.context ? "chip active" : "chip"}
        title={item.cluster ? `${item.name}\n${item.cluster}` : item.name}
        onClick={() => kubi.switchContext(item.name)}
        onContextMenu={(event) => {
          event.preventDefault();
          kubi.openContextMenu(event.clientX, event.clientY, item.name);
        }}
      >
        <i className="strip" style={{ background: clusterColor(item.name) }} />
        {initials(item.name)}
      </button>
    );
  }

  function contextRow(item: ContextInfo, zone: string, index: number) {
    const motion = rowMotion(zone, index, item.name, drag.live);
    return (
      <button
        key={item.name}
        data-ctx={item.name}
        className={["ctx", item.name === kubi.context ? "active" : "", motion.className]
          .filter(Boolean)
          .join(" ")}
        style={motion.style}
        title={item.cluster ? `${item.name}\n${item.cluster}` : item.name}
        onPointerDown={(event) => drag.down(item.name, zone, index, event)}
        onPointerMove={drag.move}
        onPointerUp={() => {
          const drop = drag.up();
          if (drop != null) commit(moveContext(layout, drop.token, drop.zone, drop.index));
        }}
        onPointerCancel={drag.cancel}
        onContextMenu={(event) => {
          event.preventDefault();
          kubi.openContextMenu(event.clientX, event.clientY, item.name);
        }}
        onClick={(event) => {
          if (drag.swallow()) {
            event.preventDefault();
            return;
          }
          kubi.switchContext(item.name);
        }}
      >
        <i className="strip" style={{ background: clusterColor(item.name) }} />
        <span className="ctx-name">{item.name}</span>
        {openTabs.has(item.name) ? (
          <span className="ctx-open" title="Open in this window" aria-label="Open in this window" />
        ) : null}
        <span className="muted">{item.cluster}</span>
      </button>
    );
  }

  return (
    <aside
      // The panel follows the pointer, but a right-click menu is drawn at the
      // cursor, outside the rail: while one is open the list stays put, so the
      // context the menu belongs to does not slide away under it.
      className={["hotbar", drag.dragging || kubi.ctxMenu != null ? "open" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-label="Contexts"
    >
      <div className="chips">
        {blocks.map((items, index) => (
          <div className="chips-block" key={items[0]?.name ?? index}>
            {index > 0 ? <i className="chips-sep" /> : null}
            {items.map(chip)}
          </div>
        ))}
      </div>
      <button className="add" title="Open kubeconfig" onClick={() => void kubi.openKubeconfig()}>
        +
      </button>

      <div className="panel">
        <div className="inner">
          <header>
            <span>Contexts</span>
            <span className="muted">{strip.length}</span>
          </header>
          <div className="panel-list">
            {rows.map((row) => {
              const shut = closed.includes(row.group.id);
              return (
                <section className="folder" key={row.group.id}>
                  <div
                    className={drag.zone === row.group.id ? "folder-head drop" : "folder-head"}
                    data-drop={row.group.id}
                  >
                    <button
                      className="twist"
                      aria-label={shut ? "Expand folder" : "Collapse folder"}
                      aria-expanded={!shut}
                      onClick={() =>
                        setClosed((current) =>
                          shut
                            ? current.filter((id) => id !== row.group.id)
                            : [...current, row.group.id],
                        )
                      }
                    >
                      {shut ? "▸" : "▾"}
                    </button>
                    {renaming?.id === row.group.id ? (
                      <input
                        className="folder-edit"
                        autoFocus
                        value={renaming.value}
                        aria-label="Folder name"
                        onChange={(event) => setRenaming({ id: row.group.id, value: event.target.value })}
                        onBlur={finishRename}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") finishRename();
                          if (event.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <button
                        className="folder-name"
                        title="Double-click to rename"
                        onDoubleClick={() => setRenaming({ id: row.group.id, value: row.group.name })}
                        onClick={() =>
                          setClosed((current) =>
                            shut
                              ? current.filter((id) => id !== row.group.id)
                              : [...current, row.group.id],
                          )
                        }
                      >
                        {row.group.name}
                      </button>
                    )}
                    <span className="muted">{row.items.length}</span>
                    <button
                      className="icon"
                      title="Rename folder"
                      aria-label="Rename folder"
                      onClick={() => setRenaming({ id: row.group.id, value: row.group.name })}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      className="icon"
                      title="Delete folder"
                      aria-label="Delete folder"
                      onClick={() =>
                        commit({ ...layout, groups: dropGroup(layout.groups, row.group.id) })
                      }
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  {shut ? null : (
                    <div
                      className={drag.zone === row.group.id ? "items drop" : "items"}
                      data-drop={row.group.id}
                      data-list={row.group.id}
                    >
                      {row.items.length === 0 ? (
                        <p className="hint">Drop contexts here</p>
                      ) : (
                        row.items.map((item, index) => contextRow(item, row.group.id, index))
                      )}
                    </div>
                  )}
                </section>
              );
            })}
            <section className="folder">
              <div className={drag.zone === "" ? "folder-head drop" : "folder-head"} data-drop="">
                <span className="twist">·</span>
                <span className="folder-name" title="Contexts that are in no folder">
                  Ungrouped
                </span>
                <span className="muted">{loose.length}</span>
              </div>
              <div className={drag.zone === "" ? "items drop" : "items"} data-drop="" data-list="">
                {loose.length === 0 ? (
                  <p className="hint">Drop here to ungroup</p>
                ) : (
                  loose.map((item, index) => contextRow(item, "", index))
                )}
              </div>
            </section>
          </div>
          <footer>
            {draft == null ? (
              <button className="ghost" onClick={() => setDraft("")}>
                + Folder
              </button>
            ) : (
              <input
                className="folder-edit"
                autoFocus
                value={draft}
                placeholder="Folder name"
                aria-label="New folder name"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => addFolder(draft)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addFolder(draft);
                  if (event.key === "Escape") setDraft(null);
                }}
              />
            )}
            {note == null ? null : <p className="bad">{note}</p>}
          </footer>
        </div>
      </div>

      {kubi.ctxMenu == null ? null : <ContextMenu kubi={kubi} />}

      {drag.live == null
        ? null
        : createPortal(
            <div
              className="ctx-ghost"
              style={{
                left: drag.live.left,
                top: drag.live.top,
                width: drag.live.width,
                height: drag.live.height,
                transform: `translate(${drag.live.dx}px, ${drag.live.dy}px)`,
              }}
            >
              <i className="strip" style={{ background: clusterColor(drag.live.token) }} />
              {drag.live.token}
            </div>,
            document.body,
          )}
    </aside>
  );
}

/**
 * What the menu holds: the cluster it belongs to, disconnect, and the palette.
 * Split from the portal below so the visual harness can render it headlessly.
 */
export function ContextMenuBody({ kubi, name }: { kubi: Kubi; name: string }) {
  const info = kubi.contexts.find((item) => item.name === name);
  const live = kubi.connectedContexts.includes(name);
  const picked = kubi.clusterColors[name] ?? null;
  return (
    <>
      <div className="menu-head" title={info?.cluster ?? name}>
        <i className="strip" style={{ background: clusterColor(name) }} />
        <span className="name">{name}</span>
        {live ? <span className="muted">connected</span> : null}
      </div>
      <button
        disabled={!live}
        title={live ? "Drop this cluster and close its tabs" : "Not connected in this window"}
        onClick={() => kubi.disconnectContext(name)}
      >
        <PowerIcon /> Disconnect
      </button>
      <div className="menu-sep" />
      <div className="menu-label">
        <DotsIcon /> Color
      </div>
      <div className="swatches">
        {CLUSTER_COLORS.map((color) => (
          <button
            key={color}
            className={color === picked ? "swatch on" : "swatch"}
            style={{ background: color }}
            title={color}
            aria-label={`Color ${color}`}
            aria-pressed={color === picked}
            onClick={() => kubi.setClusterColor(name, color)}
          />
        ))}
        <button
          className={picked == null ? "swatch auto on" : "swatch auto"}
          title="Use the color of the name"
          aria-pressed={picked == null}
          onClick={() => kubi.setClusterColor(name, null)}
        >
          auto
        </button>
      </div>
    </>
  );
}

/**
 * Right-click menu on a context. Drawn through a portal, so the rail's own
 * scrolling and dragging cannot clip it.
 */
function ContextMenu({ kubi }: { kubi: Kubi }) {
  const menu = kubi.ctxMenu;
  useEffect(() => {
    if (menu == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") kubi.closeContextMenu();
    };
    const onMouse = () => kubi.closeContextMenu();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
    };
  }, [menu, kubi]);
  if (menu == null) return null;
  return createPortal(
    <div
      className="menu ctx-menu"
      style={{
        left: Math.min(menu.x, Math.max(8, window.innerWidth - 236)),
        top: Math.min(menu.y, Math.max(8, window.innerHeight - 250)),
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ContextMenuBody kubi={kubi} name={menu.name} />
    </div>,
    document.body,
  );
}

/** Disconnect: the power symbol every other tool uses for it. */
function PowerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 2.4v5.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4.5 4.5a5 5 0 1 0 7 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Color: three dots, which is what a palette reads as at this size. */
function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="4.6" cy="8" r="1.7" fill="currentColor" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" opacity="0.7" />
      <circle cx="11.4" cy="8" r="1.7" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M10.6 2.9l2.5 2.5-7 7-2.9.4.4-2.9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3M4.5 4.5l.6 8.2h5.8l.6-8.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
