/** A single key press, modifiers included. `key` is the lowercased `event.key`. */
export type Binding = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

/** Actions the user can rebind. Everything else in the app is contextual. */
export type KeymapAction = "openSearch" | "focusFilter" | "openSettings";

export type Keymap = Record<KeymapAction, Binding>;

export type KeymapRow = {
  id: KeymapAction;
  label: string;
  hint: string;
};

export const KEYMAP_ROWS: KeymapRow[] = [
  { id: "openSearch", label: "Spotlight", hint: "Search resources and namespaces" },
  { id: "focusFilter", label: "Focus filter", hint: "Jump to the row filter of the open list" },
  { id: "openSettings", label: "Settings", hint: "Open this window" },
];

export const DEFAULT_KEYMAP: Keymap = {
  openSearch: { key: "a", ctrl: true, meta: false, alt: false, shift: false },
  focusFilter: { key: "/", ctrl: false, meta: false, alt: false, shift: false },
  openSettings: { key: ",", ctrl: true, meta: false, alt: false, shift: false },
};

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os", "altgraph", "dead", "unidentified"]);

function plain(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function binding(input: unknown, fallback: Binding): Binding {
  if (input == null || typeof input !== "object") return fallback;
  const raw = input as Partial<Record<keyof Binding, unknown>>;
  if (!plain(raw.key)) return fallback;
  return {
    key: raw.key.length === 1 ? raw.key.toLowerCase() : raw.key,
    ctrl: raw.ctrl === true,
    meta: raw.meta === true,
    alt: raw.alt === true,
    shift: raw.shift === true,
  };
}

/** Reads a stored keymap, filling anything missing or broken with defaults. */
export function parseKeymap(text: string | null): Keymap {
  const keymap: Keymap = { ...DEFAULT_KEYMAP };
  if (text == null || text.trim() === "") return keymap;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return keymap;
  }
  const stored =
    raw != null && typeof raw === "object" ? (raw as { keybindings?: unknown }).keybindings : null;
  if (stored == null || typeof stored !== "object") return keymap;
  for (const row of KEYMAP_ROWS) {
    keymap[row.id] = binding((stored as Record<string, unknown>)[row.id], DEFAULT_KEYMAP[row.id]);
  }
  return keymap;
}

/** Turns a key press into a binding, or null for a bare modifier. */
export function eventToBinding(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Binding | null {
  const key = event.key;
  if (!plain(key) || MODIFIER_KEYS.has(key.toLowerCase())) return null;
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

/** The shipped shortcut for an action. */
export function defaultFor(action: KeymapAction): Binding {
  return DEFAULT_KEYMAP[action];
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    a.ctrl === b.ctrl &&
    a.meta === b.meta &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

export function matchesBinding(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  target: Binding,
): boolean {
  const pressed = eventToBinding(event);
  return pressed != null && sameBinding(pressed, target);
}

/** The action that already owns this binding, if any. */
export function bindingOwner(keymap: Keymap, binding: Binding, except?: KeymapAction): KeymapRow | null {
  for (const row of KEYMAP_ROWS) {
    if (row.id === except) continue;
    if (sameBinding(keymap[row.id], binding)) return row;
  }
  return null;
}

/** Keycaps to draw, e.g. `["Ctrl", "A"]`. */
export function bindingKeys(binding: Binding): string[] {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.meta) parts.push("Cmd");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(binding.key === " " ? "Space" : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts;
}

/** A binding with no modifier types text, so it must not fire while typing. */
export function isTypedKey(binding: Binding): boolean {
  return !binding.ctrl && !binding.meta && !binding.alt;
}
