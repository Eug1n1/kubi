import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { ExecWindow } from "./execWindow";
import { LogWindow } from "./logWindow";
import "./styles.css";

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

const root = document.getElementById("root");
if (root) {
  const label = windowLabel();
  if (label.startsWith("log-")) {
    createRoot(root).render(<LogWindow label={label} />);
  } else if (label.startsWith("exec-")) {
    createRoot(root).render(<ExecWindow label={label} />);
  } else {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}
