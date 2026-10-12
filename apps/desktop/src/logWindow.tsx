import { useEffect, useRef, useState, type ReactNode } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { LogSnapshot } from "./types";

const LINE_CAP = 4000;

export function LogPane({
  logs,
  follow,
  onPod,
  onContainer,
  onClose,
}: {
  logs: LogSnapshot;
  follow: number | string;
  onPod: (pod: string) => void;
  onContainer: (container: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    stick.current = true;
  }, [follow]);
  useEffect(() => {
    const el = box.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [follow, logs.lines]);
  const noPods = logs.started && logs.pods.length === 0;
  return (
    <>
      <header>
        <span className="name">{logs.name}</span>
        {logs.kind !== "pods" ? (
          <select
            aria-label="Pod"
            value={logs.pods.length === 0 ? "" : logs.pod}
            disabled={logs.pods.length === 0}
            onChange={(event) => onPod(event.target.value)}
          >
            {logs.pods.length === 0 ? <option value="">{logs.started ? "No pods" : ""}</option> : null}
            {logs.pods.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Container"
          value={logs.containers.length === 0 ? "" : logs.container}
          disabled={logs.containers.length === 0}
          onChange={(event) => onContainer(event.target.value)}
        >
          {logs.containers.length === 0 ? <option value="" /> : null}
          {logs.containers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {logs.closed ? <span className="muted">stream closed</span> : null}
        <span className="spacer" />
        <button aria-label="Close logs" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="logs">
        <pre
          ref={box}
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {noPods ? "No pods" : !logs.started ? "Loading logs…" : logs.lines.join("\n")}
        </pre>
      </div>
    </>
  );
}

export function LogWindow({ label }: { label: string }) {
  const [view, setView] = useState<LogSnapshot | null>(null);
  const [follow, setFollow] = useState(0);

  useEffect(() => {
    const unlist: Array<() => void> = [];
    let stop = false;
    void (async () => {
      const mine = { target: label };
      const onSnapshot = await listen<LogSnapshot>(
        "log-snapshot",
        (event) => {
          setView(event.payload);
          setFollow((value) => value + 1);
        },
        mine,
      );
      const onLine = await listen<{ line: string }>(
        "log-line",
        (event) => {
          setView((current) => {
            if (!current) return current;
            const prior = current.lines.length >= LINE_CAP ? current.lines.slice(-(LINE_CAP - 1)) : current.lines;
            return { ...current, lines: [...prior, event.payload.line] };
          });
        },
        mine,
      );
      if (stop) {
        onSnapshot();
        onLine();
        return;
      }
      unlist.push(onSnapshot, onLine);
      await emitTo("main", "log-ready", { label });
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
        <pre>Loading logs…</pre>
      </div>
    );
  } else {
    body = (
      <LogPane
        logs={view}
        follow={follow}
        onPod={(pod) => {
          void emitTo("main", "log-pod", { label, pod });
        }}
        onContainer={(container) => {
          void emitTo("main", "log-container", { label, container });
        }}
        onClose={() => {
          void emitTo("main", "log-close", { label });
        }}
      />
    );
  }

  return (
    <section className="log-drawer log-window" aria-label="Logs">
      {body}
    </section>
  );
}
