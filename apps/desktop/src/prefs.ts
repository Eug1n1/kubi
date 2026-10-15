import { parseKeymap, type Keymap } from "./keymap";
import { DEFAULT_THEME, parseTheme, type Theme } from "./theme";

/** Everything persisted in `<app config dir>/settings.json`. */
export type Prefs = {
  keymap: Keymap;
  theme: Theme;
  /** Context colours picked by hand, by context name. */
  colors: Record<string, string>;
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Keeps only well-formed colours, so a hand-edited file cannot break the UI. */
function parseColors(input: unknown): Record<string, string> {
  if (input == null || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (name !== "" && typeof value === "string" && HEX.test(value)) out[name] = value.toLowerCase();
  }
  return out;
}

export function parsePrefs(text: string | null): Prefs {
  let theme: Theme = DEFAULT_THEME;
  let colors: Record<string, string> = {};
  if (text != null && text.trim() !== "") {
    try {
      const raw: unknown = JSON.parse(text);
      const root =
        raw != null && typeof raw === "object"
          ? (raw as { theme?: unknown; colors?: unknown })
          : {};
      theme = parseTheme(root.theme);
      colors = parseColors(root.colors);
    } catch {
      theme = DEFAULT_THEME;
      colors = {};
    }
  }
  return { keymap: parseKeymap(text), theme, colors };
}

export function serializePrefs(prefs: Prefs): string {
  return JSON.stringify(
    { version: 3, keybindings: prefs.keymap, theme: prefs.theme, colors: prefs.colors },
    null,
    2,
  );
}
