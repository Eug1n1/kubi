import { getVersion } from "@tauri-apps/api/app";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import {
  KEYMAP_ROWS,
  bindingKeys,
  bindingOwner,
  defaultFor,
  eventToBinding,
  sameBinding,
  type KeymapAction,
} from "./keymap";
import { parseHex, type Theme } from "./theme";
import type { Kubi } from "./useKubi";

/** Categories of the settings window, in the order the sidebar lists them. */
const SETTINGS_TABS: [string, string][] = [
  ["keybindings", "Keybindings"],
  ["colors", "Colors"],
  ["about", "About"],
];

/** Where installers and the update feed live when the in-place flow cannot run. */
const RELEASES_URL = "https://github.com/Eug1n1/kubi/releases";
const CHANGELOG_URL = "https://github.com/Eug1n1/kubi/blob/main/CHANGELOG.md";

/** The one-key status of the About tab: idle, busy on check or download, or settled. */
export type AboutStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; done: number; total: number | null }
  | { kind: "ready"; version: string }
  | { kind: "failed"; message: string };

/** Props the harness feeds the About screen so every state screenshots without a backend. */
export interface AboutProps {
  version: string;
  status: AboutStatus;
  onCheck: () => void;
  onDownload: () => void;
  onRestart: () => void;
}

/** A network or backend failure rewritten so a user can act on it. */
export function humanUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  console.error("update failed:", err);
  if (/updater is not configured|not supported|target/i.test(raw))
    return "Updates are available in the installed app only. Grab the installer from the releases page.";
  if (/network|fetch|failed to fetch|econn|timeout|offline|dns|ENOTFOUND|502|503/i.test(raw))
    return "Could not reach the releases page. Check the connection and try again.";
  if (/signature|public key|pubkey/i.test(raw))
    return "The update signature did not verify. Grab the installer from the releases page.";
  if (/no update|not found|404/i.test(raw))
    return "No update artifact was published for this system. Grab the installer from the releases page.";
  return "The update check failed. Try again, or grab the installer from the releases page.";
}

export function SettingsModal({ kubi }: { kubi: Kubi }) {
  const [tab, setTab] = useState("keybindings");
  const [recording, setRecording] = useState<KeymapAction | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);
  // About state lives here, not in the tab: switching tabs unmounts the tab
  // body, and unmounting must not drop a downloaded update or its status.
  const about = useAbout();

  useEffect(() => {
    if (recording != null) recorder.current?.focus();
  }, [recording]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // While recording, Esc belongs to the recorder.
      if (event.key === "Escape" && recording == null) kubi.setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kubi, recording]);

  return (
    <div className="modal-back" onMouseDown={() => kubi.setSettingsOpen(false)}>
      <div className="modal settings" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-head">
          <strong>Settings</strong>
          <span className="spacer" />
          <button aria-label="Close settings" onClick={() => kubi.setSettingsOpen(false)}>
            ×
          </button>
        </header>
        <div className="settings-split">
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_TABS.map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                aria-current={tab === id ? "true" : undefined}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-body">
            {tab === "keybindings" ? (
              <Keybindings kubi={kubi} recording={recording} onRecord={setRecording} recorder={recorder} />
            ) : null}
            {tab === "colors" ? <Colors kubi={kubi} /> : null}
            {tab === "about" ? (
              <About
                version={about.version}
                status={about.status}
                onCheck={about.onCheck}
                onDownload={about.onDownload}
                onRestart={about.onRestart}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Keybindings({
  kubi,
  recording,
  onRecord,
  recorder,
}: {
  kubi: Kubi;
  recording: KeymapAction | null;
  onRecord: (action: KeymapAction | null) => void;
  recorder: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      <p className="muted">
        Click a shortcut and press the keys you want. A shortcut without a modifier only fires outside
        text fields.
      </p>
      {KEYMAP_ROWS.map((row) => {
        const binding = kubi.keymap[row.id];
        const owner = recording === row.id ? null : bindingOwner(kubi.keymap, binding, row.id);
        const changed = !sameBinding(binding, defaultFor(row.id));
        return (
          <div className="binding" key={row.id}>
            <div className="binding-text">
              <span>{row.label}</span>
              <span className="muted">{row.hint}</span>
              {owner ? <span className="warn-text">also used by {owner.label}</span> : null}
            </div>
            {recording === row.id ? (
              <button
                ref={recorder}
                className="keys recording"
                onClick={() => onRecord(null)}
                onKeyDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    onRecord(null);
                    return;
                  }
                  const next = eventToBinding(event);
                  if (next == null) return;
                  kubi.setBinding(row.id, next);
                  onRecord(null);
                }}
              >
                Press keys…
              </button>
            ) : (
              <button className="keys" title="Change shortcut" onClick={() => onRecord(row.id)}>
                {bindingKeys(binding).map((part) => (
                  <kbd key={part}>{part}</kbd>
                ))}
              </button>
            )}
            <button
              className="icon"
              title="Reset to default"
              aria-label={`Reset ${row.label}`}
              disabled={!changed}
              onClick={() => kubi.resetBinding(row.id)}
            >
              <ResetIcon />
            </button>
          </div>
        );
      })}
      <div className="binding-footer">
        <button className="ghost" onClick={kubi.resetKeymap}>
          Reset all
        </button>
      </div>
    </>
  );
}

/** One color with a swatch picker and an editable hex field. */
function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (parseHex(draft) == null) {
      setDraft(value);
      return;
    }
    const next = draft.startsWith("#") ? draft : `#${draft}`;
    if (next.toLowerCase() !== value.toLowerCase()) onChange(next);
  };
  return (
    <div className="color-field">
      <div className="color-text">
        <span>{label}</span>
        <span className="muted">{hint}</span>
      </div>
      <input
        className="color-hex"
        value={draft}
        spellCheck={false}
        aria-label={`${label} hex value`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(value);
        }}
      />
      <input
        className="color-swatch"
        type="color"
        value={parseHex(value) != null ? value : "#000000"}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function Colors({ kubi }: { kubi: Kubi }) {
  const theme: Theme = kubi.theme;
  const [name, setName] = useState("");
  const saveTheme = () => {
    if (name.trim() === "") return;
    kubi.saveTheme(name);
    setName("");
  };
  return (
    <>
      <p className="muted">
        Surfaces are derived from the base color; the accent and status colors are used as given.
        Changes apply immediately.
      </p>
      <h3>Themes</h3>
      <div className="theme-list">
        {kubi.themes.map((item) => (
          <div key={item.id} className={item.id === kubi.activeTheme ? "theme on" : "theme"}>
            <button
              className="theme-apply"
              aria-pressed={item.id === kubi.activeTheme}
              onClick={() => kubi.selectTheme(item.id)}
            >
              <i className="theme-swatch" aria-hidden="true">
                <i style={{ background: item.theme.base }} />
                <i style={{ background: item.theme.accent }} />
              </i>
              <span className="theme-text">
                <span className="theme-name">{item.label}</span>
                {item.note == null ? null : <span className="muted">{item.note}</span>}
              </span>
            </button>
            {item.builtin ? null : (
              <button
                className="theme-delete"
                aria-label={`Delete ${item.label}`}
                title="Delete theme"
                onClick={() => kubi.deleteTheme(item.id)}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="theme-save">
        <input
          value={name}
          placeholder="Name the colors on screen…"
          aria-label="Custom theme name"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveTheme();
          }}
        />
        <button className="create" disabled={name.trim() === ""} onClick={saveTheme}>
          Save theme
        </button>
      </div>
      <div className="theme-load">
        <button className="create" onClick={() => void kubi.loadThemeFromFile()}>
          Load theme…
        </button>
        {kubi.themeNote == null ? null : (
          <p className={kubi.themeNote.kind === "bad" ? "theme-note bad" : "theme-note"}>{kubi.themeNote.text}</p>
        )}
      </div>
      <h3>Base</h3>
      <ColorField
        label="Background"
        hint="every surface is mixed from this"
        value={theme.base}
        onChange={(base) => kubi.updateTheme({ base })}
      />
      <h3>Accent and status</h3>
      <ColorField
        label="Accent"
        hint="selection, links, focus accents"
        value={theme.accent}
        onChange={(accent) => kubi.updateTheme({ accent })}
      />
      <ColorField label="Healthy" hint="ok status, healthy state" value={theme.ok} onChange={(ok) => kubi.updateTheme({ ok })} />
      <ColorField label="Warning" hint="warnings and probe noise" value={theme.warn} onChange={(warn) => kubi.updateTheme({ warn })} />
      <ColorField label="Failure" hint="errors and destructive actions" value={theme.bad} onChange={(bad) => kubi.updateTheme({ bad })} />
      <div className="binding-footer">
        <button className="ghost" onClick={kubi.resetTheme}>
          Reset colors
        </button>
      </div>
    </>
  );
}

function ResetIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M3.5 8a4.5 4.5 0 1 0 1.2-3.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.4 2.8v2.7h2.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Settings → About: the running version, the manual update check, and the docs links. */
function useAbout() {
  const [version, setVersion] = useState("…");
  const [status, setStatus] = useState<AboutStatus>({ kind: "idle" });
  // The pending Update from the last check; download/install continue from it.
  // check() hands out a backend resource, so a newer check closes the older one.
  // The ref (and the status) live as long as the modal, so switching tabs
  // cannot orphan a downloaded update; only closing Settings releases it.
  const pending = useRef<Awaited<ReturnType<typeof check>> | null>(null);

  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {
        if (live) setVersion("unknown");
      });
    return () => {
      live = false;
      void pending.current?.close().catch(() => {});
      pending.current = null;
    };
  }, []);

  const onCheck = async () => {
    if (status.kind === "checking" || status.kind === "downloading") return;
    setStatus({ kind: "checking" });
    try {
      const next = await check();
      await pending.current?.close().catch(() => {});
      pending.current = next;
      if (next == null) {
        setStatus({ kind: "uptodate" });
        return;
      }
      setStatus({ kind: "available", version: next.version });
    } catch (err) {
      await pending.current?.close().catch(() => {});
      pending.current = null;
      setStatus({ kind: "failed", message: humanUpdateError(err) });
    }
  };

  const onDownload = async () => {
    const update = pending.current;
    if (update == null || status.kind !== "available") return;
    const version = update.version;
    setStatus({ kind: "downloading", version, done: 0, total: null });
    try {
      let done = 0;
      let total: number | null = null;
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        else if (event.event === "Progress") done += event.data.chunkLength;
        setStatus({ kind: "downloading", version, done, total });
      });
      setStatus({ kind: "ready", version });
      const restart = await ask(`Update ${version} downloaded. Restart now to install?`, {
        title: "Kubi update",
        kind: "info",
        okLabel: "Restart now",
        cancelLabel: "Later",
      });
      if (restart) await onRestart();
    } catch (err) {
      setStatus({ kind: "failed", message: humanUpdateError(err) });
    }
  };

  const onRestart = async () => {
    const update = pending.current;
    if (update == null) return;
    try {
      await update.install();
      pending.current = null;
      // macOS/Linux relaunch after install; on Windows the installer already
      // restarted the app, so a second relaunch is harmless.
      await relaunch();
    } catch (err) {
      setStatus({ kind: "failed", message: humanUpdateError(err) });
    }
  };

  const run = (fn: () => Promise<void>) => () => void fn();
  return { version, status, onCheck: run(onCheck), onDownload: run(onDownload), onRestart: run(onRestart) };
}

/** The pure About screen: every state renders from props, so the harness can drive it. */
export function About({ version, status, onCheck, onDownload, onRestart }: AboutProps) {
  const busy = status.kind === "checking" || status.kind === "downloading";
  const open = (url: string) => () => void openUrl(url).catch((err) => console.error("open link:", err));
  return (
    <>
      <p className="muted">Kubi {version}</p>
      <UpdateStatus status={status} />
      {status.kind === "downloading" ? <UpdateProgress status={status} /> : null}
      <div className="binding-footer">
        <button className="create" disabled={busy} onClick={onCheck}>
          {status.kind === "checking" ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {status.kind === "available" ? (
        <p>
          <button className="ghost" onClick={onDownload}>
            Download &amp; install update {status.version}
          </button>
        </p>
      ) : null}
      {status.kind === "ready" ? (
        <p>
          <button className="ghost" onClick={onRestart}>
            Restart now to install
          </button>
        </p>
      ) : null}
      {status.kind === "failed" ? (
        <p>
          <button className="ghost" onClick={open(RELEASES_URL)}>
            Open releases page
          </button>
        </p>
      ) : null}
      <p className="muted">
        <button className="ghost" onClick={open(CHANGELOG_URL)}>
          See what&apos;s new
        </button>{" "}
        <button className="ghost" onClick={open(RELEASES_URL)}>
          Releases
        </button>
      </p>
    </>
  );
}

function UpdateStatus({ status }: { status: AboutStatus }) {
  switch (status.kind) {
    case "idle":
      return <p className="muted">Not checked yet.</p>;
    case "checking":
      return <p className="muted">Checking for updates…</p>;
    case "uptodate":
      return <p>You&apos;re up to date.</p>;
    case "available":
      return <p>Update {status.version} available.</p>;
    case "downloading":
      return <p className="muted">Downloading update {status.version}…</p>;
    case "ready":
      return <p>Update {status.version} ready. Restart to apply it.</p>;
    case "failed":
      return <p className="theme-note bad">{status.message}</p>;
  }
}

function UpdateProgress({ status }: { status: Extract<AboutStatus, { kind: "downloading" }> }) {
  if (status.total == null) return <p className="muted">{Math.round(status.done / 1024)} KB downloaded…</p>;
  const pct = Math.min(100, Math.round((status.done / status.total) * 100));
  return (
    <p className="muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      Downloading… {pct}%
    </p>
  );
}
