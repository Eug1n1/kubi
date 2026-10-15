import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { LogSnapshot } from "./types";
import { ownerOfLabel } from "./windows";

const LINE_CAP = 4000;

/** The RFC3339 prefix the API server adds when timestamps are on. */
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?: (.*))?$/;

/** Renders the API timestamp dimmer than the message itself. */
function LogLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, index) => {
        const parts = TIMESTAMP.exec(line);
        return (
          <Fragment key={index}>
            {index > 0 ? "\n" : null}
            {parts ? (
              <>
                <span className="log-ts">{parts[1]}</span>
                {parts[2] ? ` ${parts[2]}` : ""}
              </>
            ) : (
              line
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export function LogPane({
  logs,
  follow,
  onPod,
  onContainer,
  onPrevious,
  onTimestamps,
  onClose,
}: {
  logs: LogSnapshot;
  follow: number | string;
  onPod: (pod: string) => void;
  onContainer: (container: string) => void;
  onPrevious: (value: boolean) => void;
  onTimestamps: (value: boolean) => void;
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
        <button
          className={logs.previous ? "icon on" : "icon"}
          aria-pressed={logs.previous}
          aria-label="Previous container logs"
          title="Logs from the previous container instance"
          onClick={() => onPrevious(!logs.previous)}
        >
          <HistoryIcon />
        </button>
        <button
          className={logs.timestamps ? "icon on" : "icon"}
          aria-pressed={logs.timestamps}
          aria-label="Show timestamps"
          title="Prefix every line with its RFC3339 timestamp"
          onClick={() => onTimestamps(!logs.timestamps)}
        >
          <ClockIcon />
        </button>
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
          {noPods ? "No pods" : !logs.started ? "Loading logs…" : logs.timestamps ? <LogLines lines={logs.lines} /> : logs.lines.join("\n")}
        </pre>
      </div>
    </>
  );
}

export function LogWindow({ label }: { label: string }) {
  // The window this pane answers to: the one that opened it, from the label.
  const owner = ownerOfLabel(label);
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
      await emitTo(owner, "log-ready", { label });
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
          void emitTo(owner, "log-pod", { label, pod });
        }}
        onContainer={(container) => {
          void emitTo(owner, "log-container", { label, container });
        }}
        onPrevious={(value) => {
          void emitTo(owner, "log-previous", { label, value });
        }}
        onTimestamps={(value) => {
          void emitTo(owner, "log-timestamps", { label, value });
        }}
        onClose={() => {
          void emitTo(owner, "log-close", { label });
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

/** Arrow turning back: the container instance before the current one. */
function HistoryIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 8a4.5 4.5 0 1 0 1.2-3.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.4 2.8v2.7h2.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5v3.1l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
