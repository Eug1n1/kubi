import type { DetailSection, RelatedGroup } from "./types";

/** Where a section sits in the Overview tab, and whether it starts folded. */
type SectionLayout = { order: number; folded?: boolean };

/**
 * The layout of the sections the engine sends. The engine decides what a
 * section holds and this decides where the panel puts it, so a section can be
 * added without the engine knowing the panel's order.
 */
const LAYOUT: Record<string, SectionLayout> = {
  Object: { order: 10 },
  Status: { order: 20 },
  // Where a pod may land is a long list of keys; it is worth opening on purpose.
  Scheduling: { order: 40, folded: true },
  Labels: { order: 90, folded: true },
  Annotations: { order: 91, folded: true },
};

/**
 * A section this table has never heard of is a kind's own — the rows the engine
 * reads out of one kind's spec — so it lands between the object's status and the
 * metadata lists, and keeps its arrival order among its neighbours. A section
 * that belongs somewhere else gets named above.
 */
const UNKNOWN_ORDER = 30;

/** Where the related blocks sit among the sections the engine sends. */
const RELATED_ORDER = 50;

/** Where live usage sits: after the relations, before the metadata lists. */
const USAGE_ORDER = 60;

/**
 * A place in the Overview: a section the engine sent, or one of the panel's own
 * blocks.
 */
export type Block =
  | { kind: "section"; section: DetailSection }
  | { kind: "facts" }
  | { kind: "related" }
  | { kind: "usage" };

/**
 * The Overview's blocks in order: the object's own rows, the objects it points
 * at, the usage the object does not carry, then the metadata lists.
 *
 * Three of these come from somewhere other than the sections — the row-derived
 * facts from the list, the related rows from a request of their own, the usage
 * from the metrics API — so this is what keeps them in one order instead of
 * leaving the Overview to place them by hand.
 */
export function overviewBlocks(
  sections: DetailSection[],
  extras: { facts?: boolean; related?: boolean; usage?: boolean } = {},
): Block[] {
  const blocks: { order: number; block: Block }[] = sections.map((section) => ({
    order: LAYOUT[section.title]?.order ?? UNKNOWN_ORDER,
    block: { kind: "section" as const, section },
  }));
  // A kind's row-derived facts are its own rows, so they land with them.
  if (extras.facts) blocks.push({ order: UNKNOWN_ORDER, block: { kind: "facts" } });
  if (extras.related) blocks.push({ order: RELATED_ORDER, block: { kind: "related" } });
  if (extras.usage) blocks.push({ order: USAGE_ORDER, block: { kind: "usage" } });
  return blocks
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((entry) => entry.block);
}

/**
 * How complete a relation's list is: `100 of 312`, `100+`, or just the count. A
 * relation that could not be read has no count to give, because the block says
 * why instead — a header claiming `Services 0` above "not allowed" would be
 * saying the cluster holds none.
 */
export function relatedCount(group: RelatedGroup): string | null {
  if (group.note != null) return null;
  if (!group.truncated) return String(group.rows.length);
  return group.total == null ? `${group.rows.length}+` : `${group.rows.length} of ${group.total}`;
}

/** Whether a section is collapsed until the user opens it. */
export function startsFolded(title: string): boolean {
  return LAYOUT[title]?.folded ?? false;
}

/** A row that only repeats its section's title does not repeat it on screen. */
export function rowCaption(section: string, label: string): string | null {
  return label === section ? null : label;
}

/**
 * A condition's reason, unless it only repeats the condition's own name: the
 * scheduler reports the `PodScheduled` reason for the `PodScheduled` condition,
 * and saying it twice reads as noise.
 */
export function conditionReason(name: string, reason: string): string | null {
  return reason === "" || reason === name ? null : reason;
}

/**
 * What a folded section shows as its count. A section of one table holds many
 * entries, so counting rows would say "1" for a ConfigMap with forty keys.
 */
export function sectionCount(section: DetailSection): number {
  const only = section.rows.length === 1 ? section.rows[0] : null;
  if (only == null) return section.rows.length;
  if ("table" in only) return only.table.rows.length;
  if ("list" in only) return only.list.items.length;
  if ("badges" in only) return only.badges.items.length;
  if ("ports" in only) return only.ports.ports.length;
  if ("links" in only) return only.links.links.length;
  if ("conditions" in only) return only.conditions.conditions.length;
  return section.rows.length;
}
