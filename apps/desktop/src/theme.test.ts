import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  contrastRatio,
  parseHex,
  parseTheme,
  parseThemeFile,
  parseThemes,
  sameTheme,
  serializeThemes,
  themeTokens,
  uniqueThemeId,
} from "./theme";

describe("parseHex", () => {
  it("reads six-digit, three-digit and hash-less colors", () => {
    expect(parseHex("#268bd2")).toEqual([0x26, 0x8b, 0xd2]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("000000")).toEqual([0, 0, 0]);
  });

  it("refuses anything else", () => {
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("red")).toBeNull();
    expect(parseHex("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("spans the WCAG range", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("does not care about the order of its arguments", () => {
    expect(contrastRatio("#268bd2", "#0b1021")).toBeCloseTo(contrastRatio("#0b1021", "#268bd2"), 10);
  });
});

describe("parseTheme", () => {
  it("falls back per field rather than refusing the whole theme", () => {
    expect(parseTheme({ base: "#10201e", accent: "not a color" })).toEqual({
      ...DEFAULT_THEME,
      base: "#10201e",
    });
  });

  it("treats any mode but light as dark", () => {
    expect(parseTheme({ mode: "light" }).mode).toBe("light");
    expect(parseTheme({ mode: "sepia" }).mode).toBe("dark");
  });

  it("returns the default for anything that is not an object", () => {
    expect(parseTheme(null)).toEqual(DEFAULT_THEME);
    expect(parseTheme("Solar")).toEqual(DEFAULT_THEME);
  });
});

describe("sameTheme", () => {
  it("ignores the case of the colors", () => {
    expect(sameTheme({ ...DEFAULT_THEME, base: "#AABBCC" }, { ...DEFAULT_THEME, base: "#aabbcc" })).toBe(true);
    expect(sameTheme(DEFAULT_THEME, { ...DEFAULT_THEME, mode: "light" })).toBe(false);
  });
});

describe("uniqueThemeId", () => {
  it("slugs a name and suffixes it until it is unused", () => {
    expect(uniqueThemeId("Solar Flare", [])).toBe("solar-flare");
    expect(uniqueThemeId("Solar Flare", ["solar-flare"])).toBe("solar-flare-2");
    expect(uniqueThemeId("Solar Flare", ["solar-flare", "solar-flare-2"])).toBe("solar-flare-3");
  });

  it("falls back to a usable id for a name with nothing in it", () => {
    expect(uniqueThemeId("  ", [])).toBe("theme");
  });
});

describe("themeTokens", () => {
  it("uses the base color as the window background", () => {
    expect(themeTokens({ ...DEFAULT_THEME, base: "#0b1021" })["--bg"]).toBe("#0b1021");
  });

  it("gives a light theme a light background and a dark one the opposite", () => {
    const light = themeTokens({ ...DEFAULT_THEME, base: "#f4f5f7", mode: "light" });
    const dark = themeTokens({ ...DEFAULT_THEME, base: "#0b1021", mode: "dark" });
    expect(contrastRatio(light["--bg"] ?? "", "#ffffff")).toBeLessThan(
      contrastRatio(dark["--bg"] ?? "", "#ffffff"),
    );
    expect(contrastRatio(dark["--fg"] ?? "", dark["--bg"] ?? "")).toBeGreaterThan(7);
  });

  it("moves the accent until it reads on the surface it lands on", () => {
    const tokens = themeTokens({ ...DEFAULT_THEME, base: "#0b1021", accent: "#268bd2" });
    expect(contrastRatio(tokens["--accent-text"] ?? "", tokens["--bg-panel"] ?? "")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens["--on-accent"] ?? "", tokens["--accent-fill"] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the status colors as given", () => {
    const theme = { ...DEFAULT_THEME, ok: "#859900", warn: "#b58900", bad: "#dc322f" };
    const tokens = themeTokens(theme);
    expect(tokens["--ok"]).toBe("#859900");
    expect(tokens["--warn"]).toBe("#b58900");
    expect(tokens["--bad"]).toBe("#dc322f");
  });
});

describe("the shipped themes", () => {
  it("includes the default theme under DEFAULT_THEME_ID", () => {
    expect(BUILTIN_THEMES.map((item) => item.id)).toContain(DEFAULT_THEME_ID);
  });

  it("gives every theme a unique id and a label", () => {
    const ids = BUILTIN_THEMES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of BUILTIN_THEMES) expect(item.label.trim()).not.toBe("");
  });
});

describe("parseThemes", () => {
  it("reads a stored file and drops entries that cannot be listed", () => {
    const themes = parseThemes(
      JSON.stringify({ version: 1, themes: [{ name: "Solar", base: "#0b1021" }, { base: "#000000" }, null, "Solar"] }),
    );
    expect(themes).toHaveLength(1);
    expect(themes[0]?.label).toBe("Solar");
    expect(themes[0]?.builtin).toBe(false);
  });

  it("suffixes a custom theme that collides with a shipped one", () => {
    const themes = parseThemes(JSON.stringify([{ name: "Neutral", base: "#101010" }]));
    expect(themes[0]?.id).not.toBe(DEFAULT_THEME_ID);
  });

  it("yields nothing for a missing, empty or broken file", () => {
    expect(parseThemes(null)).toEqual([]);
    expect(parseThemes("   ")).toEqual([]);
    expect(parseThemes("{ broken")).toEqual([]);
    expect(parseThemes(JSON.stringify({ version: 1 }))).toEqual([]);
  });
});

describe("serializeThemes", () => {
  it("writes the custom themes and leaves the shipped ones out", () => {
    const stored = serializeThemes([
      ...BUILTIN_THEMES,
      { id: "solar", label: "Solar", builtin: false, theme: DEFAULT_THEME },
    ]);
    const parsed = JSON.parse(stored) as { version: number; themes: { name: string }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.themes.map((item) => item.name)).toEqual(["Solar"]);
  });

  it("round-trips a theme through a file", () => {
    const custom = {
      id: "solar",
      label: "Solar",
      builtin: false,
      theme: { ...DEFAULT_THEME, base: "#10201e", accent: "#2dd4bf" },
    };
    expect(parseThemes(serializeThemes([custom]))[0]?.theme).toEqual(custom.theme);
  });
});

describe("parseThemeFile", () => {
  it("accepts one theme, an array, and a pack under `themes`", () => {
    const one = parseThemeFile(JSON.stringify({ name: "Solar", base: "#0b1021", mode: "dark" }));
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.themes[0]?.theme.base).toBe("#0b1021");

    const pack = parseThemeFile(JSON.stringify({ themes: [{ name: "A" }, { name: "B" }] }));
    expect(pack.ok).toBe(true);
    if (pack.ok) expect(pack.themes.map((item) => item.label)).toEqual(["A", "B"]);
  });

  it("names what is wrong instead of applying a broken theme", () => {
    const broken = parseThemeFile("{ not json");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("not valid JSON");

    const badColor = parseThemeFile(JSON.stringify({ name: "Solar", accent: "blue" }));
    expect(badColor.ok).toBe(false);
    if (!badColor.ok) expect(badColor.error).toContain("accent is not a color");

    const badMode = parseThemeFile(JSON.stringify({ name: "Solar", mode: "sepia" }));
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) expect(badMode.error).toContain("mode");

    const nameless = parseThemeFile(JSON.stringify({ base: "#000000" }));
    expect(nameless.ok).toBe(false);
    if (!nameless.ok) expect(nameless.error).toContain("no name");

    expect(parseThemeFile("{}").ok).toBe(false);
  });

  it("fills a missing color from the defaults", () => {
    const theme = parseThemeFile(JSON.stringify({ name: "Solar", base: "#0b1021" }));
    expect(theme.ok).toBe(true);
    if (theme.ok) expect(theme.themes[0]?.theme.accent).toBe(DEFAULT_THEME.accent);
  });
});
