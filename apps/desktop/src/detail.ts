import type { DetailSection } from "./types";

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
  Labels: { order: 90, folded: true },
  Annotations: { order: 91, folded: true },
};

/** A section this table has never heard of lands after every named one. */
const UNKNOWN_ORDER = 100;

/**
 * The sections in the order the panel shows them. A section the layout does not
 * name keeps its arrival order, so a kind's own sections can be added to the
 * engine before the panel knows about them.
 */
export function orderSections(sections: DetailSection[]): DetailSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((left, right) => {
      const leftOrder = LAYOUT[left.section.title]?.order ?? UNKNOWN_ORDER;
      const rightOrder = LAYOUT[right.section.title]?.order ?? UNKNOWN_ORDER;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map((entry) => entry.section);
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
  if ("links" in only) return only.links.links.length;
  if ("conditions" in only) return only.conditions.conditions.length;
  return section.rows.length;
}
