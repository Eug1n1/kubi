# The detail panel follows the object through the list's watch

The detail panel was a snapshot: selecting a row read the object once — `FetchYaml`
answers with the YAML and the Overview sections together — and a pod's containers
once more, and nothing refreshed either while that row stayed selected. A pod
that left `Pending` went on saying `containerInitializing`/`Pending` until the
row was clicked again.

Now the engine keeps what each window is showing — `SelectObject { window,
context, target, namespace, name, uid, reveal, read }` — and the watch that
already lists the kind reads it on every change it receives. The object it has
just delivered is the object the panel needs, so the sections cost no request of
their own: the `to_sections` hook the one-shot read already takes now rides
alongside `to_row` in `spawn_watch`. A pod's containers are rebuilt from that
object plus the ConfigMaps and Secrets read when the pod was selected, which stay
valid because a pod's mounts and environment cannot change without a new uid.

## Considered Options

- **Re-fetch the detail from the front end when the list changes** — rejected:
  it puts a second reader of the cluster in the UI and costs one or two requests
  per change, where the watch already holds the object.
- **A second watch on the single selected object** — rejected: one more stream
  per selection, with its own teardown, for the events the list watch is already
  receiving.
- **A read-only `FetchDetail` for refreshes** — rejected as unnecessary: the
  watch's event never carries YAML, so a refresh cannot clobber the editor.
- **Polling the selected object on a timer** — rejected: the panel would lag the
  cluster by the interval and ask about objects that did not change.

## Consequences

- The selection is keyed by window and cluster. Two windows browse one cluster at
  once (ADR 0001), so a second window's selection must not replace the first
  one's. The emitted event carries no window: each window matches it against its
  own selected uid, so one event serves every window showing that object.
- A change reaches the panel once per `resourceVersion`. A watch that re-lists —
  after a `410`, or when a tab comes back to the front and its watch is restarted
  — repeats versions the panel already has.
- The registration is dropped only on an explicit change of selection or on
  `ClearSelection`. Closing a tab, disconnecting a cluster and closing a window
  leave it behind, and that is deliberate: a uid identifies one instance of an
  object, so a stale registration can never match anything again, and the front
  end ignores an event for a uid it is not showing. The cost is a map entry, not
  a wrong panel.
- The sources cache does not follow that rule, because it holds resolved Secret
  values rather than an identifier: it is dropped as soon as no selection refers
  to it. It does still outlive a `disconnect` or a closed window, because the
  registration does; those values had already been sent to that window and shown
  there.
- Because the cache is dropped that eagerly, a pod selection whose sources have
  gone reads them again — the containers only, never the YAML. The panel on
  screen still holds the containers and re-registers without a read, so without
  this the card would stop following the pod for good the first time another
  tab took the selection over.
- A pod's YAML, sections, containers and sources now come from one read of it, so
  selecting a pod costs one request where it used to cost two plus the referenced
  ConfigMaps and Secrets.
- `read` is the one read a selection needs, not a refresh: a tab coming back to
  the front registers without reading, which is what keeps an unsaved YAML draft.
  Only a pod's sources can be read on that path, and only when they are missing.
- The registration follows the tab in front, so a row that took the focus over —
  because the focused one left the list — is registered and read by the same
  function that a click goes through.
- A new kind gets its live panel part by naming its sections function in the
  watch macros; a kind without sections of its own passes `no_sections`.
