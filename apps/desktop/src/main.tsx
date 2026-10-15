import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ExecWindow } from "./execWindow";
import { LogWindow } from "./logWindow";
import { currentWindowLabel, pinnedContext } from "./windows";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  const label = currentWindowLabel();
  if (label.startsWith("log-")) {
    createRoot(root).render(<LogWindow label={label} />);
  } else if (label.startsWith("exec-")) {
    createRoot(root).render(<ExecWindow label={label} />);
  } else {
    createRoot(root).render(
      <StrictMode>
        {/* A ctx-* label is a context window: the App renders one cluster, the
            name of which came with the URL. */}
        <App pinned={label.startsWith("ctx-") ? pinnedContext() : null} />
      </StrictMode>,
    );
  }
}
