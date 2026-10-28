import { describe, expect, it } from "vitest";

import { DEFAULT_KEYMAP } from "./keymap";
import { parsePrefs, serializePrefs, type Prefs } from "./prefs";
import { DEFAULT_THEME, DEFAULT_THEME_ID } from "./theme";

describe("parsePrefs", () => {
  it("returns the defaults for a fresh install", () => {
    const prefs = parsePrefs(null);
    expect(prefs.theme).toEqual(DEFAULT_THEME);
    expect(prefs.keymap).toEqual(DEFAULT_KEYMAP);
    expect(prefs.colors).toEqual({});
    // Nobody has edited the colors, so the settings screen can name the theme.
    expect(prefs.themeName).toBe(DEFAULT_THEME_ID);
  });

  it("returns the defaults for an empty or unreadable file", () => {
    for (const text of ["", "   ", "{ broken", "null", "42"]) {
      const prefs = parsePrefs(text);
      expect(prefs.theme).toEqual(DEFAULT_THEME);
      expect(prefs.themeName).toBe(DEFAULT_THEME_ID);
      expect(prefs.colors).toEqual({});
    }
  });

  it("keeps only colors a hand-edited file cannot break", () => {
    const prefs = parsePrefs(
      JSON.stringify({
        colors: { "prod-eu": "#AABBCC", bad: "red", short: "#abc", "": "#123456", num: 42, nil: null },
      }),
    );
    expect(prefs.colors).toEqual({ "prod-eu": "#aabbcc" });
  });

  it("treats a non-object colors field as none at all", () => {
    expect(parsePrefs(JSON.stringify({ colors: "prod-eu" })).colors).toEqual({});
    expect(parsePrefs(JSON.stringify({ colors: 7 })).colors).toEqual({});
    expect(parsePrefs(JSON.stringify({ colors: null })).colors).toEqual({});
  });

  it("keeps a stored theme and the name it came from", () => {
    const prefs = parsePrefs(JSON.stringify({ theme: { base: "#10201e", mode: "light" }, themeName: "Solar" }));
    expect(prefs.theme.base).toBe("#10201e");
    expect(prefs.theme.mode).toBe("light");
    expect(prefs.themeName).toBe("Solar");
  });

  it("leaves the name empty for colors edited by hand", () => {
    const prefs = parsePrefs(JSON.stringify({ theme: { base: "#10201e" } }));
    expect(prefs.themeName).toBeNull();
  });

  it("ignores a themeName that is not a usable string", () => {
    expect(parsePrefs(JSON.stringify({ themeName: "" })).themeName).toBe(DEFAULT_THEME_ID);
    expect(parsePrefs(JSON.stringify({ themeName: 7 })).themeName).toBe(DEFAULT_THEME_ID);
  });
});

describe("serializePrefs", () => {
  it("writes the version the reader expects", () => {
    const raw = JSON.parse(serializePrefs(parsePrefs(null))) as Record<string, unknown>;
    expect(raw.version).toBe(4);
    expect(Object.keys(raw).sort()).toEqual(["colors", "keybindings", "theme", "themeName", "version"]);
  });

  it("round-trips everything it holds", () => {
    const prefs: Prefs = {
      keymap: { ...DEFAULT_KEYMAP, openSearch: { ...DEFAULT_KEYMAP.openSearch, key: "k" } },
      theme: { ...DEFAULT_THEME, base: "#10201e" },
      themeName: null,
      colors: { "prod-eu": "#123456" },
    };
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
  });

  it("keeps the active theme's name across a restart", () => {
    const prefs = parsePrefs(JSON.stringify({ themeName: "Solar" }));
    expect(parsePrefs(serializePrefs(prefs)).themeName).toBe("Solar");
  });
});
