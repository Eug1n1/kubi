import { defineConfig } from "vitest/config";

/**
 * The pure modules only — formatting, keybindings, stored preferences, theme
 * math, window labels. There is no DOM and no Tauri here, so a test is fast and
 * needs nothing running; anything that renders is checked through the harness
 * (`make preview`, `make shots`) instead.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
