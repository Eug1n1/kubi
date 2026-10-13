import { parseKeymap, type Keymap } from "./keymap";
import { DEFAULT_THEME, parseTheme, type Theme } from "./theme";

/** Everything persisted in `<app config dir>/settings.json`. */
export type Prefs = {
  keymap: Keymap;
  theme: Theme;
};

export function parsePrefs(text: string | null): Prefs {
  let theme: Theme = DEFAULT_THEME;
  if (text != null && text.trim() !== "") {
    try {
      const raw: unknown = JSON.parse(text);
      theme = parseTheme(raw != null && typeof raw === "object" ? (raw as { theme?: unknown }).theme : null);
    } catch {
      theme = DEFAULT_THEME;
    }
  }
  return { keymap: parseKeymap(text), theme };
}

export function serializePrefs(prefs: Prefs): string {
  return JSON.stringify({ version: 2, keybindings: prefs.keymap, theme: prefs.theme }, null, 2);
}
