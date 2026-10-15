import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * A window label is also an address. The label of a dock window says which
 * window owns it — `log-3:ctx-prod` answers to that context window, `log-3`
 * to the main one — and a context window's label starts with `ctx-`.
 */

/** This window's label: the address dock windows answer to. */
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

/** The suffix a dock label carries when it belongs to a window other than the main one. */
export function ownerSuffix(owner: string): string {
  return owner === "main" ? "" : `:${owner}`;
}

/** The window a dock label answers to. */
export function ownerOfLabel(label: string): string {
  const at = label.indexOf(":");
  return at === -1 ? "main" : label.slice(at + 1);
}

/**
 * The context a `ctx-*` window is pinned to. The exact name rides in the
 * window's URL, where every character a label cannot hold survives untouched;
 * the label is only an address, so it works from a slug.
 */
export function pinnedContext(): string | null {
  const name = new URLSearchParams(window.location.search).get("context");
  return name != null && name.trim() !== "" ? name : null;
}
