import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { readGroupsFile, writeGroupsFile } from "./api";
import { clusterColor, initials } from "./format";
import type { ContextGroup, ContextInfo } from "./types";
import type { Kubi } from "./useKubi";

export function newGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Reads the stored layout, dropping anything malformed. Context names are kept
 * even when the current kubeconfig does not have them, so switching kubeconfigs
 * back and forth is lossless.
 */
export function parseGroups(text: string | null): ContextGroup[] {
  if (text == null || text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : raw != null && typeof raw === "object" && Array.isArray((raw as { groups?: unknown }).groups)
      ? ((raw as { groups: unknown[] }).groups)
      : [];
  const groups: ContextGroup[] = [];
  const names = new Set<string>();
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") continue;
    const item = entry as { id?: unknown; name?: unknown; contexts?: unknown };
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name === "" || names.has(name)) continue;
    names.add(name);
    const contexts = Array.isArray(item.contexts)
      ? [...new Set(item.contexts.filter((value): value is string => typeof value === "string" && value !== ""))]
      : [];
    groups.push({
      id: typeof item.id === "string" && item.id !== "" ? item.id : newGroupId(),
      name,
      contexts,
    });
  }
  return groups;
}

export function serializeGroups(groups: ContextGroup[]): string {
  return JSON.stringify({ version: 1, groups }, null, 2);
}

/** Moves a context into `groupId`, or out of every folder when it is null. */
export function assignContext(
  groups: ContextGroup[],
  context: string,
  groupId: string | null,
): ContextGroup[] {
  const stripped = groups.map((group) => ({
    ...group,
    contexts: group.contexts.filter((name) => name !== context),
  }));
  if (groupId == null) return stripped;
  return stripped.map((group) =>
    group.id === groupId ? { ...group, contexts: [...group.contexts, context] } : group,
  );
}

export function dropGroup(groups: ContextGroup[], id: string): ContextGroup[] {
  return groups.filter((group) => group.id !== id);
}

export function renameGroup(groups: ContextGroup[], id: string, name: string): ContextGroup[] {
  const trimmed = name.trim();
  if (trimmed === "") return groups;
  return groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group));
}

/** Folder rows with their live contexts, plus the contexts no folder claims. */
export function partitionContexts(
  groups: ContextGroup[],
  contexts: ContextInfo[],
): { rows: { group: ContextGroup; items: ContextInfo[] }[]; loose: ContextInfo[] } {
  const byName = new Map(contexts.map((item) => [item.name, item]));
  const claimed = new Set<string>();
  const rows = groups.map((group) => {
    const items: ContextInfo[] = [];
    for (const name of group.contexts) {
      const item = byName.get(name);
      if (item == null || claimed.has(name)) continue;
      claimed.add(name);
      items.push(item);
    }
    return { group, items };
  });
  return { rows, loose: contexts.filter((item) => !claimed.has(item.name)) };
}

type Drop = { token: string; zone: string | null };

type DragState = {
  token: string;
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
  moved: boolean;
  /** `null` = nowhere, `""` = the ungrouped area, otherwise a folder id. */
  zone: string | null;
};

/** Pointer-based drag: HTML5 drag events are unreliable inside the webview. */
function useContextDrag() {
  const drag = useRef<DragState | null>(null);
  const skipClick = useRef(false);
  const [live, setLive] = useState<Omit<DragState, "moved" | "x" | "y"> | null>(null);
  return {
    live,
    zone: live?.zone ?? null,
    dragging: live != null,
    down(token: string, event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      skipClick.current = false;
      drag.current = {
        token,
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
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    move(event: ReactPointerEvent<HTMLElement>) {
      const state = drag.current;
      if (state == null) return;
      state.dx = event.clientX - state.x;
      state.dy = event.clientY - state.y;
      if (!state.moved) {
        if (Math.hypot(state.dx, state.dy) <= 4) return;
        state.moved = true;
      }
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const host = under instanceof Element ? under.closest("[data-drop]") : null;
      state.zone = host?.getAttribute("data-drop") ?? null;
      setLive({
        token: state.token,
        left: state.left,
        top: state.top,
        width: state.width,
        height: state.height,
        dx: state.dx,
        dy: state.dy,
        zone: state.zone,
      });
    },
    up(): Drop | null {
      const state = drag.current;
      drag.current = null;
      setLive(null);
      if (state == null || !state.moved) return null;
      skipClick.current = true;
      return state.zone == null ? null : { token: state.token, zone: state.zone };
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
  const [groups, setGroups] = useState<ContextGroup[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [closed, setClosed] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const drag = useContextDrag();

  useEffect(() => {
    let stop = false;
    void readGroupsFile()
      .then((text) => {
        if (!stop) setGroups(parseGroups(text));
      })
      .catch(() => {
        if (!stop) setNote("Folders could not be read");
      });
    return () => {
      stop = true;
    };
  }, []);

  function commit(next: ContextGroup[]) {
    setGroups(next);
    void writeGroupsFile(serializeGroups(next)).catch(() => setNote("Folders could not be saved"));
  }

  function addFolder(name: string) {
    const trimmed = name.trim();
    if (trimmed === "") {
      setDraft(null);
      return;
    }
    if (groups.some((group) => group.name === trimmed)) {
      setNote(`"${trimmed}" already exists`);
      return;
    }
    setNote(null);
    commit([...groups, { id: newGroupId(), name: trimmed, contexts: [] }]);
    setDraft(null);
  }

  function finishRename() {
    if (renaming == null) return;
    const trimmed = renaming.value.trim();
    if (trimmed === "" || groups.some((group) => group.name === trimmed && group.id !== renaming.id)) {
      setNote(trimmed === "" ? null : `"${trimmed}" already exists`);
      setRenaming(null);
      return;
    }
    setNote(null);
    commit(renameGroup(groups, renaming.id, trimmed));
    setRenaming(null);
  }

  function drop(token: string, zone: string | null) {
    commit(assignContext(groups, token, zone === "" || zone == null ? null : zone));
  }

  const { rows, loose } = partitionContexts(groups, kubi.contexts);
  const blocks = [...rows.filter((row) => row.items.length > 0).map((row) => row.items)];
  if (loose.length > 0) blocks.push(loose);
  const strip = blocks.flat();

  function chip(item: ContextInfo) {
    return (
      <button
        key={item.name}
        className={item.name === kubi.context ? "chip active" : "chip"}
        title={item.cluster ? `${item.name}\n${item.cluster}` : item.name}
        onClick={() => kubi.switchContext(item.name)}
      >
        <i className="strip" style={{ background: clusterColor(item.name) }} />
        {initials(item.name)}
      </button>
    );
  }

  function contextRow(item: ContextInfo) {
    const active = item.name === kubi.context;
    const held = drag.live?.token === item.name;
    return (
      <button
        key={item.name}
        className={["ctx", active ? "active" : "", held ? "held" : ""].filter(Boolean).join(" ")}
        title={item.cluster ? `${item.name}\n${item.cluster}` : item.name}
        onPointerDown={(event) => drag.down(item.name, event)}
        onPointerMove={drag.move}
        onPointerUp={() => {
          const drop2 = drag.up();
          if (drop2 != null) drop(drop2.token, drop2.zone);
        }}
        onPointerCancel={drag.cancel}
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
        <span className="muted">{item.cluster}</span>
      </button>
    );
  }

  return (
    <aside
      className={["hotbar", drag.dragging ? "open" : ""].filter(Boolean).join(" ")}
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
                      onClick={() => commit(dropGroup(groups, row.group.id))}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  {shut ? null : (
                    <div className={drag.zone === row.group.id ? "items drop" : "items"} data-drop={row.group.id}>
                      {row.items.length === 0 ? <p className="hint">Drop contexts here</p> : row.items.map(contextRow)}
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
              <div className={drag.zone === "" ? "items drop" : "items"} data-drop="">
                {loose.length === 0 ? <p className="hint">Drop here to ungroup</p> : loose.map(contextRow)}
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

      {drag.live == null
        ? null
        : createPortal(
            <div
              className="ctx-ghost"
              style={{
                left: drag.live.left + drag.live.dx,
                top: drag.live.top + drag.live.dy,
                width: drag.live.width,
                height: drag.live.height,
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
