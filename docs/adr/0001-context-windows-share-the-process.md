# Context windows share the process

When a context is opened separately, its window is a `WebviewWindow` in the
same process as the main window — not a second app process. The one engine owns
all per-context state (clients, watches) and is the only truth about what is
connected; every window filters the broadcast `kubi` channel to the contexts it
shows. A context window keeps working when the main window moves elsewhere, and
closing it leaves the context connected.

## Considered Options

- **A second app process** (own engine, full isolation): rejected — macOS
  LaunchServices does not open a second instance of a bundled app without
  `open -n`, dock windows could not be shared, and two processes would race
  their writes to `settings.json` and `context-groups.json`.

## Consequences

- Dock windows (log/exec) must address the window that opened them, not a
  hardcoded `main`.
- A connection is a process-wide fact: a context connected by one window shows
  as connected in every window, by design.
