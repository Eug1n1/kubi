/**
 * Theming: one base color drives every surface, accent and status colors stay
 * explicit. Tokens are emitted as CSS custom properties, so the whole UI
 * re-themes live. Nothing here touches the DOM by itself.
 */

export type ThemeMode = "dark" | "light";

export type Theme = {
  /** Canvas color; every surface is derived from it. */
  base: string;
  mode: ThemeMode;
  accent: string;
  ok: string;
  warn: string;
  bad: string;
};

export type ThemeTokens = Record<string, string>;

export const DEFAULT_THEME: Theme = {
  base: "#181818",
  mode: "dark",
  accent: "#4c8dff",
  ok: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
};

/** A theme with the name it is listed and stored under. */
export type NamedTheme = {
  /** Stable id: how the active theme is remembered and how the file keys it. */
  id: string;
  label: string;
  /** Shipped themes come from code; only custom ones can be edited away. */
  builtin: boolean;
  /** One line under the name, e.g. which theme it is the counterpart of. */
  note?: string;
  theme: Theme;
};

/**
 * The themes the app ships with. The first two are a pair — the dark default
 * and its light counterpart, same accent and status colors — and the rest vary
 * only the base color.
 */
export const BUILTIN_THEMES: NamedTheme[] = [
  {
    id: "neutral",
    label: "Neutral",
    builtin: true,
    note: "the app's dark default",
    theme: DEFAULT_THEME,
  },
  {
    id: "day",
    label: "Day",
    builtin: true,
    note: "the light counterpart of Neutral",
    theme: { ...DEFAULT_THEME, base: "#f4f5f7", mode: "light" },
  },
  { id: "slate", label: "Slate", builtin: true, theme: { ...DEFAULT_THEME, base: "#1b2027" } },
  { id: "ink", label: "Ink", builtin: true, theme: { ...DEFAULT_THEME, base: "#0f1012" } },
  { id: "graphite", label: "Graphite", builtin: true, theme: { ...DEFAULT_THEME, base: "#212121" } },
];

/** Where a fresh install starts: the dark one of the shipped pair. */
export const DEFAULT_THEME_ID = "neutral";

/** Version of the stored themes file; unknown keys are ignored on read. */
export const THEMES_VERSION = 1;

/** A theme as it appears in a file: a name plus the six theme fields. */
type ThemeDocument = { name: string } & Theme;

/** A stable id for a theme someone named: lowercase, dashes, unicode kept. */
function themeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "theme" : slug;
}

/** A fresh id for a theme someone named: the slug, suffixed until it is unused. */
export function uniqueThemeId(name: string, taken: Iterable<string>): string {
  const slug = themeId(name);
  const seen = new Set(taken);
  if (!seen.has(slug)) return slug;
  let n = 2;
  while (seen.has(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

/**
 * Reads the stored themes file — `{ version, themes: [...] }` or a bare array —
 * keeping only entries that can be listed: a named object whose colors fall back
 * per field. A file that is missing, empty or unreadable yields no themes, so
 * the shipped ones keep working.
 */
export function parseThemes(text: string | null): NamedTheme[] {
  if (text == null || text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : raw != null && typeof raw === "object" && Array.isArray((raw as { themes?: unknown }).themes)
      ? (raw as { themes: unknown[] }).themes
      : [];
  const out: NamedTheme[] = [];
  const seen = new Set(BUILTIN_THEMES.map((item) => item.id));
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || name.trim() === "") continue;
    // Two names can slug to the same id; the second one gets a suffix.
    const id = uniqueThemeId(name, seen);
    seen.add(id);
    out.push({ id, label: name.trim(), builtin: false, theme: parseTheme(entry) });
  }
  return out;
}

/** The themes file as stored JSON: the custom themes, built-ins left out. */
export function serializeThemes(themes: NamedTheme[]): string {
  const documents: ThemeDocument[] = themes
    .filter((item) => !item.builtin)
    .map((item) => ({ name: item.label, ...item.theme }));
  return JSON.stringify({ version: THEMES_VERSION, themes: documents }, null, 2);
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

type Rgb = [number, number, number];

export function parseHex(value: string): Rgb | null {
  const match = HEX.exec(value.trim());
  if (match == null) return null;
  const digits = match[1] ?? "";
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((char) => char + char)
          .join("")
      : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, "0")).join("")}`;
}

/** `t` of 0 returns `from`, 1 returns `to`. */
export function mix(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (a == null || b == null) return from;
  return toHex([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(color: string): number {
  const rgb = parseHex(color) ?? [0, 0, 0];
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const [hi, lo] = first >= second ? [first, second] : [second, first];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `color`. */
export function onColor(color: string): string {
  return contrastRatio(color, "#ffffff") >= contrastRatio(color, "#141414") ? "#ffffff" : "#141414";
}

/** Moves `color` away from `on` until the two reach the target contrast. */
export function fillFor(color: string, on = "#ffffff", target = 4.5): string {
  const toward = luminance(on) > 0.5 ? "#000000" : "#ffffff";
  let result = color;
  for (let step = 0; step < 24 && contrastRatio(result, on) < target; step += 1) {
    result = mix(result, toward, 0.1);
  }
  return result;
}

function rgba(color: string, alpha: number): string {
  const rgb = parseHex(color) ?? [0, 0, 0];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Every CSS custom property the stylesheet reads. */
export function themeTokens(theme: Theme): ThemeTokens {
  const dark = theme.mode === "dark";
  const base = parseHex(theme.base) != null ? theme.base : DEFAULT_THEME.base;
  const toward = dark ? "#ffffff" : "#000000";
  const lighten = (amount: number) => mix(base, toward, amount);
  const rawAccent = parseHex(theme.accent) != null ? theme.accent : DEFAULT_THEME.accent;
  const accentFill = fillFor(rawAccent, "#ffffff");
  // The worst surface an accent can sit on: lightest in dark mode, darkest in light.
  const accentCanvas = dark ? lighten(0.055) : mix(base, "#000000", 0.1);
  const accentText = dark ? lighten(0.16) : mix(base, "#000000", 0.1);
  const accent = fillFor(rawAccent, accentCanvas, 3);

  return {
    "--bg": base,
    "--bg-chrome": dark ? lighten(0.03) : mix(base, "#000000", 0.035),
    "--bg-panel": dark ? lighten(0.055) : mix(base, "#ffffff", 0.62),
    "--field": dark ? lighten(0.078) : mix(base, "#ffffff", 0.72),
    "--hover": dark ? lighten(0.105) : mix(base, "#000000", 0.055),
    "--selected": dark ? lighten(0.16) : mix(base, "#000000", 0.1),
    "--border": dark ? lighten(0.1) : mix(base, "#000000", 0.13),
    "--border-strong": dark ? lighten(0.24) : mix(base, "#000000", 0.26),
    "--fg": dark ? lighten(0.9) : mix(base, "#000000", 0.88),
    "--muted": dark ? lighten(0.66) : mix(base, "#000000", 0.62),
    "--dim": dark ? lighten(0.55) : mix(base, "#000000", 0.6),
    "--accent": accent,
    /* Accent as text: pushed further until it reads on any surface it lands on. */
    "--accent-text": fillFor(rawAccent, accentText, 4.5),
    "--accent-hi": dark ? mix(accent, "#ffffff", 0.28) : mix(accent, "#000000", 0.2),
    "--accent-fill": accentFill,
    "--accent-fill-hi": mix(accentFill, "#ffffff", 0.12),
    "--accent-soft": rgba(rawAccent, dark ? 0.16 : 0.12),
    "--on-accent": onColor(accentFill),
    "--ok": theme.ok,
    "--warn": theme.warn,
    "--bad": theme.bad,
    "--on-warn": onColor(theme.warn),
    "--focus": dark ? lighten(0.92) : mix(base, "#000000", 0.72),
    "--scroll": dark ? lighten(0.18) : mix(base, "#000000", 0.22),
    "--scroll-hover": dark ? lighten(0.3) : mix(base, "#000000", 0.36),
    "--bad-soft": rgba(theme.bad, dark ? 0.12 : 0.1),
    "--bad-border": rgba(theme.bad, dark ? 0.45 : 0.4),
    "--bad-fg": dark ? mix(theme.bad, "#ffffff", 0.55) : mix(theme.bad, "#000000", 0.25),
    "--scrim": dark ? "rgba(0, 0, 0, 0.62)" : "rgba(18, 22, 30, 0.38)",
    "--shadow": dark ? "rgba(0, 0, 0, 0.5)" : "rgba(20, 24, 32, 0.22)",
    "--selection": rgba(rawAccent, 0.22),
  };
}

export function applyTheme(theme: Theme, root?: HTMLElement): void {
  const target = root ?? document.documentElement;
  for (const [name, value] of Object.entries(themeTokens(theme))) {
    target.style.setProperty(name, value);
  }
  target.dataset.theme = theme.mode;
  // Native scrollbars, selects and form controls follow the mode too.
  target.style.colorScheme = theme.mode;
}

function color(input: unknown, fallback: string): string {
  return typeof input === "string" && parseHex(input) != null ? input : fallback;
}

/** Reads a stored theme, falling back per field. */
export function parseTheme(input: unknown): Theme {
  if (input == null || typeof input !== "object") return DEFAULT_THEME;
  const raw = input as Partial<Record<keyof Theme, unknown>>;
  return {
    base: color(raw.base, DEFAULT_THEME.base),
    mode: raw.mode === "light" ? "light" : "dark",
    accent: color(raw.accent, DEFAULT_THEME.accent),
    ok: color(raw.ok, DEFAULT_THEME.ok),
    warn: color(raw.warn, DEFAULT_THEME.warn),
    bad: color(raw.bad, DEFAULT_THEME.bad),
  };
}

export function sameTheme(a: Theme, b: Theme): boolean {
  return (
    a.base.toLowerCase() === b.base.toLowerCase() &&
    a.mode === b.mode &&
    a.accent.toLowerCase() === b.accent.toLowerCase() &&
    a.ok.toLowerCase() === b.ok.toLowerCase() &&
    a.warn.toLowerCase() === b.warn.toLowerCase() &&
    a.bad.toLowerCase() === b.bad.toLowerCase()
  );
}
