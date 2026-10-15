import { invoke } from "@tauri-apps/api/core";
import type { Command } from "./types";

export function send(command: Command): Promise<void> {
  return invoke("send_command", { command });
}

/** Context folders as stored JSON, or null before the first save. */
export function readGroupsFile(): Promise<string | null> {
  return invoke<string | null>("load_context_groups");
}

export function writeGroupsFile(data: string): Promise<void> {
  return invoke("save_context_groups", { data });
}

/** App settings as stored JSON, or null before the first save. */
export function readSettingsFile(): Promise<string | null> {
  return invoke<string | null>("load_settings");
}

export function writeSettingsFile(data: string): Promise<void> {
  return invoke("save_settings", { data });
}

/** Custom color themes as stored JSON, or null before the first save. */
export function readThemesFile(): Promise<string | null> {
  return invoke<string | null>("load_themes");
}

export function writeThemesFile(data: string): Promise<void> {
  return invoke("save_themes", { data });
}

/** A theme file the user picked in the dialog, as text. */
export function readThemeFile(path: string): Promise<string> {
  return invoke<string>("load_theme_file", { path });
}
