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
];

export function SettingsModal({ kubi }: { kubi: Kubi }) {
  const [tab, setTab] = useState("keybindings");
  const [recording, setRecording] = useState<KeymapAction | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);

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
