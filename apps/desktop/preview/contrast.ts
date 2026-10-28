import { DEFAULT_THEME, BUILTIN_THEMES, contrastRatio, themeTokens, type Theme } from "../src/theme";

/** Every text/surface pair the stylesheet actually relies on. */
const PAIRS: [string, string, number][] = [
  ["--fg", "--bg", 7],
  ["--fg", "--bg-panel", 7],
  ["--fg", "--field", 7],
  ["--muted", "--bg-panel", 4.5],
  ["--muted", "--bg-chrome", 4.5],
  ["--dim", "--field", 4.5],
  ["--dim", "--bg", 4.5],
  ["--accent-text", "--bg", 4.5],
  ["--accent-text", "--bg-panel", 4.5],
  ["--accent-text", "--field", 4.5],
  ["--accent", "--bg", 3],
  ["--on-accent", "--accent-fill", 4.5],
  ["--on-warn", "--warn", 4.5],
  ["--bad-fg", "--bg-panel", 4.5],
  ["--border", "--bg", 1],
];

let failures = 0;
const cases: [string, Theme][] = [
  ["default dark", DEFAULT_THEME],
  ...BUILTIN_THEMES.map((item) => [item.label, item.theme] as [string, Theme]),
  ["custom teal", { ...DEFAULT_THEME, base: "#10201e", accent: "#2dd4bf" }],
  ["custom amber accent", { ...DEFAULT_THEME, base: "#1a1611", accent: "#f5a524" }],
];
for (const [label, theme] of cases) {
  const tokens = themeTokens(theme);
  const worst: string[] = [];
  for (const [fg, bg, min] of PAIRS) {
    const ratio = contrastRatio(tokens[fg] ?? "#000", tokens[bg] ?? "#000");
    if (ratio < min) worst.push(`${fg} on ${bg} = ${ratio.toFixed(2)} < ${min}`);
  }
  failures += worst.length;
  console.log(
    `${worst.length === 0 ? "PASS" : "FAIL"} ${label.padEnd(18)} mode=${theme.mode.padEnd(5)} base=${theme.base}` +
      (worst.length > 0 ? `\n    FAIL ${worst.join("\n    FAIL ")}` : "  all pairs pass"),
  );
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
// The exit code is what makes this a gate: `make contrast` and CI read it, so a
// palette that fails a pair cannot pass silently.
process.exit(failures === 0 ? 0 : 1);
