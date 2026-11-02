# Related objects are listed by the engine

The detail panel shows an object's relations as lists the engine resolves: the
pods of a Service or a workload, the pods on a Node, the ReplicaSets of a
Deployment, the Services an Ingress points at. ADR 0002 deferred exactly this —
"related-object tables that need a label-selector query" — and this is where they
land.

A relation that names exactly one object is not a list at all — a Pod's node, a
PVC's volume, a PV's claim — and becomes a link row in the object's own section,
which the panel already draws. Only the one-to-many relations get new machinery:
a `FetchRelated` command, a `RelatedRows` event, and one block per relation in
the Overview.

The engine decides which relations an object has. It holds the typed spec the
selectors live in, and the cost of a relation — a bounded list, a cap, a refusal
— belongs where the query runs. The front end would otherwise need the object in
TypeScript, which it does not have, and would duplicate what `spec.selector`
means.

| Kind | Lists | Single links |
| --- | --- | --- |
| Pods | — | Node, Service account |
| Deployments | Pods (labels), ReplicaSets (children) | — |
| ReplicaSets | Pods (labels) | — |
| StatefulSets | Pods (labels) | — |
| DaemonSets | Pods (labels) | — |
| Services | Pods (labels) | — |
| Nodes | Pods (field `spec.nodeName`) | — |
| Ingresses | Services (names) | — |
| PersistentVolumeClaims | — | PersistentVolume (`spec.volumeName`) |
| PersistentVolumes | — | PersistentVolumeClaim (`spec.claimRef`) |

Three mechanisms resolve a list, and each relation says which one it uses:

- **A label selector** — a Service's `spec.selector`, a workload's
  `spec.selector.matchLabels` — matched against Pods.
- **A field selector** — a Node's `spec.nodeName` against Pods.
- **A list and a filter**, for what no selector expresses: a Deployment's
  ReplicaSets are those whose `ownerReferences` name it, and an Ingress's
  Services are those its backends name. The filter is one list of the child kind
  in the namespace, not a request per name, so the cost is bounded by the
  namespace rather than by the object.

The relations are asked for when a row is selected, and then kept current. The
panel is live (ADR 0003): the watch that lists the kind re-derives the object's
sections on every change it receives, and it hands the panel the object's
*relation queries* alongside them — the title, the kind, and the selector, field
or names each list would be read by. Those are free to compute, because they are
a function of the object the watch already has. The rows are not: they cost a
list. So the front end asks for the rows once on selection, and then asks again
on two triggers — when a relation's query is not the one it last fetched, which
the panel can see for itself, and on a timer, because a Service's own object does
not change while its pods come and go.

The cadence is the one the window already uses for warning events: a change may
refresh at most every eight seconds, and a timer forces one at least every twenty
("so badges do not go stale"). A relation is not watched: watches are keyed by
target, so a live relation would add one per selected object and outlive the
selection.

A list is capped at a hundred rows and says so — `Pods 100 of 312` — with a
`Show all` that asks again for that one relation and no other. That one list is
bounded in turn at ten thousand rows, so a `Show all` cannot run away. The total comes
from the list's `remainingItemCount`; where the API server leaves that empty the
engine asks for one row more than the cap, so "exactly a hundred" and "more than
a hundred" stay different answers. A refusal and an empty result are reported in
the block they belong to rather than in the window's error banner: they are facts
about this object, and a banner across the window would claim otherwise.

## Considered Options

- **Filtering rows the window is already watching** — rejected: it needs a tab of
  that kind open on the same namespace, and the selector would have to be read
  back out of the YAML the front end happens to hold.
- **A watch per relation** — rejected: watches are keyed by target, so a live
  relation would add one per selected object and outlive the selection it was
  opened for.
- **Carrying the rows inside the existing `ObjectDetail` sections** — rejected: a
  section row holds text the engine has already formatted, and a related row is
  an object the user can click into. It would mean a second row kind duplicating
  `ResourceRow`.
- **Truncating silently** — rejected: a panel that shows a hundred of three
  hundred pods without saying so is lying about the cluster.
- **One `Related` block holding every relation** — rejected: two relations fold
  independently, and a Deployment with both pods and ReplicaSets wants both.
- **A fixed set of columns for a related block** — rejected: a pod should look
  like a pod wherever it appears, and `columns.ts` is the one place that says
  what a pod's columns are.
- **Letting the engine own the refresh, pushing rows on its own timer** —
  rejected: the window's one throttle already lives in the front end beside the
  panel's other per-feature freshness state, and the "show all" a refresh must
  not undo is a button's state.
- **Re-deriving the rows on every change the watch delivers** — rejected: that is
  a list per event, and the watch is meant to be free.
- **Refreshing only when the object changes** — rejected: a Service's own object
  does not change while its pods come and go, so the count most worth having
  would go stale indefinitely.
- **Refreshing only on a timer** — rejected: it spends a list on objects nothing
  is changing.

## Consequences

- `Command::FetchRelated` and `AppEvent::RelatedRows` join the hand-mirrored
  protocol, so they need the four places plus `tests/protocol_mirror.rs`.
  `expand` names the one relation to return in full, because "show all" belongs
  to a block and not to the object.
- `ObjectDetail` grows `relations: Vec<RelationSpec>` — the queries, not the rows.
  They are what lets the panel tell a relation it has already read from one whose
  query has just changed, without asking the engine what it last asked for.
- Freshness is not engine state. `Selection` is untouched: the cadence and the
  expansion live in the front end beside `eventsFor`, `sourcesFor` and
  `detailFor`, which is where the panel already keeps the freshness of every
  other part of itself.
- The per-kind section builders return `KindRows { sections, relations }` instead
  of `Vec<DetailSection>`, so a kind derives its selectors from the same typed
  struct it reads its rows from and a renamed field still fails to compile.
- A related block draws its columns from `columnsFor(kind)`, so a wide relation
  scrolls sideways inside its block rather than reflowing, which is what the
  panel's tables already do.
- The object decides a relation's scope, not the tab's namespace filter: a Node's
  pods come from every namespace, and the block shows the Namespace column so
  they can be told apart.
- The band the related blocks occupy is named in `detail.ts` beside the rest of
  the layout, so ADR 0002's rule that the front end owns the layout still holds —
  and the `Usage` block, which had been positioned by hand in the Overview, moves
  into it.
- `openNamed` already takes a target and an explicit context, so a related row is
  clickable with no new navigation.
- These are the first reads Kubi makes on behalf of an object other than the one
  selected, so a cluster that forbids listing pods shows that as a note in the
  block rather than as a failed panel.

