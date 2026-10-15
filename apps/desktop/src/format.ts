export function formatAge(secs: number): string {
  if (!Number.isFinite(secs) || secs > 1e12) return "-";
  const whole = Math.floor(secs);
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (whole < minute) return `${whole}s`;
  if (whole < hour) return `${Math.floor(whole / minute)}m`;
  if (whole < day) return `${Math.floor(whole / hour)}h`;
  return `${Math.floor(whole / day)}d`;
}

export function liveAge(ageSecs: number, observedAt: number | null, now: number): number {
  if (!Number.isFinite(ageSecs) || ageSecs > 1e12 || observedAt == null) return ageSecs;
  return ageSecs + Math.max(0, (now - observedAt) / 1000);
}

export function formatCpu(millis: number): string {
  if (millis >= 1000) {
    const cores = millis / 1000;
    if (Math.abs(cores - Math.round(cores)) < 0.05) return cores.toFixed(0);
    return cores.toFixed(2);
  }
  if (millis >= 10) return `${millis.toFixed(0)}m`;
  return `${millis.toFixed(1)}m`;
}

export function formatCpuPair(usage: number | null, request: number | null): string {
  if (usage != null && request != null) return `${formatCpu(usage)} / ${formatCpu(request)}`;
  if (usage != null) return formatCpu(usage);
  if (request != null) return `- / ${formatCpu(request)}`;
  return "-";
}

export function formatBytes(bytes: number): string {
  const units: [string, number][] = [
    ["Ti", 1024 ** 4],
    ["Gi", 1024 ** 3],
    ["Mi", 1024 ** 2],
    ["Ki", 1024],
  ];
  for (const [suffix, mul] of units) {
    if (bytes >= mul) {
      const value = bytes / mul;
      return value >= 10 ? `${value.toFixed(0)}${suffix}` : `${value.toFixed(1)}${suffix}`;
    }
  }
  return `${bytes.toFixed(0)}B`;
}

export function formatBytesPair(usage: number | null, request: number | null): string {
  if (usage != null && request != null) return `${formatBytes(usage)} / ${formatBytes(request)}`;
  if (usage != null) return formatBytes(usage);
  if (request != null) return `- / ${formatBytes(request)}`;
  return "-";
}

export function previewValue(value: string): string {
  const head = [...value].slice(0, 4000).join("");
  return [...value].length > 4000 ? `${head}\n… truncated` : head;
}

export function initials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
      : [...name].filter((char) => /[a-zA-Z0-9]/.test(char)).slice(0, 2).join("");
  return letters.toUpperCase() || "?";
}

/* Context strip hues: mid-lightness, so they read on the dark chrome. */
export const CLUSTER_COLORS = [
  "#4c8dff",
  "#3fb950",
  "#d29922",
  "#a371f7",
  "#39c5cf",
  "#f778ba",
  "#7ee787",
  "#ff9e64",
];

/**
 * Colours the user picked for a context, by context name. Kept in a module
 * variable because `clusterColor` is called from plain helpers as well as from
 * components; the window mirrors the same map in its state, so a change
 * re-renders everything that shows a colour.
 */
let chosen: Record<string, string> = {};

export function setClusterColors(next: Record<string, string>): void {
  chosen = next;
}

/** The context colour: the one the user picked, or the hue of its name. */
export function clusterColor(name: string): string {
  const picked = chosen[name];
  if (picked) return picked;
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash ^ name.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return CLUSTER_COLORS[hash % CLUSTER_COLORS.length] ?? CLUSTER_COLORS[0];
}
