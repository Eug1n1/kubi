/**
 * Screenshots every page the visual harness wrote, so a UI change can be looked
 * at without a human driving a browser.
 *
 *   node preview/shots.mjs [size] [outDir]
 *
 * Defaults to 1200x900 into preview/shots-<timestamp>/. CHROME overrides the
 * browser, SHOT_SIZE and SHOT_OUT the defaults. Exits non-zero when there is
 * nothing to shoot or no browser to shoot with, so it is safe as a gate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const size = process.argv[2] ?? process.env.SHOT_SIZE ?? "1200,900";
const outDir = resolve(process.argv[3] ?? process.env.SHOT_OUT ?? join(here, `shots-${Date.now()}`));

/** The first browser we can actually run: macOS Chrome, then a Linux name. */
function browser() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "chromium",
    "google-chrome",
    "chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      execFileSync("command", ["-v", candidate], { shell: "/bin/sh", stdio: "ignore" });
      return candidate;
    } catch {
      // Not on PATH: try the next name.
    }
  }
  return null;
}

const pages = readdirSync(here)
  .filter((name) => /^page-.*\.html$/.test(name))
  .sort();
if (pages.length === 0) {
  console.error("no page-*.html here — run `make preview` first");
  process.exit(1);
}

const chrome = browser();
if (chrome == null) {
  console.error("no Chrome or Chromium found — set CHROME to its path");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const started = Date.now();
for (const page of pages) {
  const shot = join(outDir, page.replace(/\.html$/, ".png"));
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      // Pages animate; the virtual clock makes a shot reproducible instead of
      // racing the timers.
      "--virtual-time-budget=2500",
      `--window-size=${size}`,
      `--screenshot=${shot}`,
      `file://${join(here, page)}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const bytes = statSync(shot).size;
  console.log(`${String(bytes).padStart(8)}  ${shot}`);
}
console.log(`${pages.length} page(s) in ${((Date.now() - started) / 1000).toFixed(1)}s → ${outDir}`);
