import { invoke } from "@tauri-apps/api/core";
import type { Command } from "./types";

export function send(command: Command): Promise<void> {
  return invoke("send_command", { command });
}
