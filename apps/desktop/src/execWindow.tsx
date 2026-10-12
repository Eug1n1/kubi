import { useEffect, useRef, useState, type ReactNode } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ExecSnapshot } from "./types";

const TEXT_CAP = 200_000;

function clip(text: string): string {
  return text.length > TEXT_CAP ? text.slice(text.length - TEXT_CAP) : text;
}

export function ExecTerm({
  sessionId,
  readText,
  bind,
  onInput,
  onResize,
}: {
  sessionId: number;
  readText: () => string;
  bind: (write: ((text: string) => void) | null) => void;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef({ readText, bind, onInput, onResize });
  api.current = { readText, bind, onInput, onResize };
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const release = api.current.bind;
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, monospace",
      cursorBlink: true,
      theme: { background: "#1e1e1e", foreground: "#dedede", cursor: "#378ef0" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);
    fit.fit();
    const snapshot = api.current.readText();
    release((text) => terminal.write(text));
    if (snapshot) terminal.write(snapshot);
    const input = terminal.onData((data) => api.current.onInput(data));
    const sendSize = () => {
      fit.fit();
      api.current.onResize(terminal.cols, terminal.rows);
    };
    sendSize();
    const observer = new ResizeObserver(sendSize);
    observer.observe(node);
    return () => {
      observer.disconnect();
      input.dispose();
      release(null);
      terminal.dispose();
    };
  }, [sessionId]);
  return <div className="exec-term" ref={host} />;
}

export function ExecPane({
  session,
  onContainer,
  onClose,
  readText,
  bind,
  onInput,
  onResize,
}: {
  session: ExecSnapshot;
  onContainer: (container: string) => void;
  onClose: () => void;
  readText: () => string;
  bind: (write: ((text: string) => void) | null) => void;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  return (
    <>
      <header>
        <span className="name">
          {session.namespace ? `${session.namespace}/` : ""}
          {session.name}
        </span>
        <select
          aria-label="Container"
          value={session.container}
          disabled={session.containers.length === 0}
          onChange={(event) => onContainer(event.target.value)}
        >
          {session.containers.length === 0 ? <option value="" /> : null}
          {session.containers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {session.closed ? <span className="muted">session closed</span> : null}
        <span className="spacer" />
        <button aria-label="Close exec" onClick={onClose}>
          ×
        </button>
      </header>
      <ExecTerm
        sessionId={session.id}
        readText={readText}
        bind={bind}
        onInput={onInput}
        onResize={onResize}
      />
    </>
  );
}

export function ExecWindow({ label }: { label: string }) {
  const [view, setView] = useState<ExecSnapshot | null>(null);
  const text = useRef("");
  const write = useRef<((chunk: string) => void) | null>(null);
  const shown = useRef<number | null>(null);

  useEffect(() => {
    const unlist: Array<() => void> = [];
    let stop = false;
    void (async () => {
      const mine = { target: label };
      const onSnapshot = await listen<ExecSnapshot>(
        "exec-snapshot",
        (event) => {
          const next = event.payload;
          if (write.current == null || shown.current !== next.id) {
            text.current = next.text;
            shown.current = next.id;
          }
          setView(next);
        },
        mine,
      );
      const onData = await listen<{ text: string }>(
        "exec-data",
        (event) => {
          const chunk = event.payload.text;
          text.current = clip(text.current + chunk);
          write.current?.(chunk);
        },
        mine,
      );
      if (stop) {
        onSnapshot();
        onData();
        return;
      }
      unlist.push(onSnapshot, onData);
      await emitTo("main", "exec-ready", { label });
    })();
    return () => {
      stop = true;
      unlist.forEach((fn) => fn());
    };
  }, [label]);

  let body: ReactNode;
  if (!view) {
    body = (
      <div className="logs">
        <pre>Connecting…</pre>
      </div>
    );
  } else {
    body = (
      <ExecPane
        session={view}
        onContainer={(container) => {
          void emitTo("main", "exec-container", { label, container });
        }}
        onClose={() => {
          void emitTo("main", "exec-close", { label });
        }}
        readText={() => text.current}
        bind={(sink) => {
          write.current = sink;
        }}
        onInput={(data) => {
          void emitTo("main", "exec-input", { label, data });
        }}
        onResize={(cols, rows) => {
          void emitTo("main", "exec-resize", { label, cols, rows });
        }}
      />
    );
  }

  return (
    <section className="log-drawer log-window" aria-label="Exec">
      {body}
    </section>
  );
}
