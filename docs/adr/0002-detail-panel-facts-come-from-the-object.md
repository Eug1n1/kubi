# Detail panel facts come from the object, not the table row

The detail panel's Overview tab becomes a stack of sections whose content the
engine builds from the object it already fetches for the YAML tab, and sends as
a new `ObjectDetail` event. The generic part of every object — UID, resource
version, owner references, finalizers, labels, annotations, conditions — is
derived from the fetched `serde_json::Value`, so custom resources get it without
a line of per-kind code; the per-kind sections come from the typed structs the
engine already deserializes before it turns them into YAML. The layout — which
sections, in what order, foldable or not — stays in the front end, in one
declarative table keyed by section title.

Today the Overview tab renders a handful of facts taken from the object's table
row, so it can only ever show what the list already shows: a namespace is a
`Phase`, a role is a rule count, and every kind the switch does not know falls
through a default branch that prints the row's raw cells. The row is a table
projection, and the panel needs the object.

## Considered Options

- **Keep adding panel-only fields to `ResourceRow`** — rejected: every
  panel-only field would be carried by every row of every list render.
- **Parse in TypeScript the YAML the UI already receives** — rejected: it puts
  the object's shape in two places and gives up the typed structs the engine
  already holds.
- **A Lens-style registry of detail items with an order number** — rejected:
  Lens needs one because it is a platform for third-party extensions; Kubi has
  no extension surface, so a registry buys indirection and nothing else.
- **A flat stack of sections instead of tabs**, which is Lens's shape —
  rejected: the tabs are what keep events, sources and metrics lazy, and a flat
  stack would either fetch everything on selection or need lazy-on-scroll,
  which the panel does not have.

## Consequences

- `DetailRow` is a new enum in the protocol, so it belongs in
  `tests/protocol_mirror.rs`, and the event needs a line in `model::serde_tests`.
- The generic sections ship first; the per-kind ones follow, kind by kind. Until
  a kind has its own sections, `resourceFacts`'s arm for it stays, because
  deleting an arm before its replacement lands would leave the panel saying less
  than it does now. An arm is deleted in the same change that adds the sections
  replacing it, and the whole switch — including the branch that printed every
  cell, which is all a custom resource has — goes when the last kind is
  migrated. Twelve kinds have made the move so far; the record is amended again
  when the switch goes.
- A kind whose numbers are not on the object keeps them where they were: live
  CPU and memory come from the metrics API, so pods and nodes read them off the
  row into a Usage block rather than pretending the object carries them.
- Age stays where it is. The Overview's Summary already shows a live age from
  the row, and a second, frozen copy in the Object section would disagree with
  it a minute later.
- The layout table is keyed by section title, not by kind, so one section is
  folded or ordered the same way wherever it appears. A kind that needs its own
  arrangement needs a second axis in that table, not a second table.
- A section the table does not name is a kind's own, so it lands between the
  object's status and the metadata lists and keeps its arrival order among its
  neighbours.
- A custom resource gets the generic sections and no per-kind ones, which is
  what a CRD can honestly support.
- Owner references link for the kinds that actually own objects — the workload
  controllers and the Service that owns its EndpointSlices. Anything else, a
  custom kind above all, renders as text: `ownerReferences` carries no plural,
  so a custom target cannot be built without a discovery lookup.
- A link between objects must name its context explicitly. The existing
  `openNamed` takes it from the current session, which is wrong in a context
  window and in a second cluster.
- Related-object tables that need a label-selector query — the pods of a
  service, the pods on a node — need an engine command of their own and are not
  part of this decision.
