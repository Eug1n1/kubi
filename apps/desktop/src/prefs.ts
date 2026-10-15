import { parseKeymap, type Keymap } from "./keymap";
import { DEFAULT_THEME, DEFAULT_THEME_ID, parseTheme, sameTheme, type Theme } from "./theme";

/** Everything persisted in `<app config dir>/settings.json`. */
export type Prefs = {
  keymap: Keymap;
  theme: Theme;
  /**
   * Id of the named theme the colors came from, so the settings screen can say
   * which one is active. `null` when the colors were picked by hand from no
   * theme in particular.
   */
  themeName: string | null;
  /** Context colors picked by hand, by context name. */
  colors: Record<string, string>;
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Keeps only well-formed colors, so a hand-edited file cannot break the UI. */
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
  let themeName: string | null = null;
  let colors: Record<string, string> = {};
  if (text != null && text.trim() !== "") {
    try {
      const raw: unknown = JSON.parse(text);
      const root =
        raw != null && typeof raw === "object"
          ? (raw as { theme?: unknown; themeName?: unknown; colors?: unknown })
          : {};
      theme = parseTheme(root.theme);
      themeName = typeof root.themeName === "string" && root.themeName !== "" ? root.themeName : null;
      colors = parseColors(root.colors);
    } catch {
      theme = DEFAULT_THEME;
      themeName = null;
      colors = {};
    }
  }
  // A fresh install, or a file written before themes had names: the colors are
  // the default theme's exactly when nobody has edited them.
  if (themeName == null && sameTheme(theme, DEFAULT_THEME)) themeName = DEFAULT_THEME_ID;
  return { keymap: parseKeymap(text), theme, themeName, colors };
}

export function serializePrefs(prefs: Prefs): string {
  return JSON.stringify(
    {
      version: 4,
      keybindings: prefs.keymap,
      theme: prefs.theme,
      themeName: prefs.themeName,
      colors: prefs.colors,
    },
    null,
    2,
  );
}
