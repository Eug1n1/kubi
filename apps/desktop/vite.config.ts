import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Vendor code split into its own chunks: one big bundle was over Vite's 500 kB
 * warning limit, and separate chunks are cached on their own. */
function manualChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("@xterm")) return "xterm";
  if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) return "react";
  if (id.includes("@tauri-apps")) return "tauri";
  return "vendor";
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    outDir: "dist",
    rollupOptions: {
      output: { manualChunks },
    },
  },
});
