import type { CrTarget, ResourceKind, View } from "./types";

export const TITLES: Record<ResourceKind, string> = {
  nodes: "Nodes",
  namespaces: "Namespaces",
  events: "Events",
  pods: "Pods",
  deployments: "Deployments",
  replicaSets: "ReplicaSets",
  statefulSets: "StatefulSets",
  daemonSets: "DaemonSets",
  jobs: "Jobs",
  cronJobs: "CronJobs",
  services: "Services",
  endpoints: "Endpoints",
  endpointSlices: "EndpointSlices",
  ingresses: "Ingresses",
  ingressClasses: "IngressClasses",
  networkPolicies: "NetworkPolicies",
  configMaps: "ConfigMaps",
  secrets: "Secrets",
  resourceQuotas: "ResourceQuotas",
  limitRanges: "LimitRanges",
  horizontalPodAutoscalers: "HorizontalPodAutoscalers",
  podDisruptionBudgets: "PodDisruptionBudgets",
  persistentVolumeClaims: "PersistentVolumeClaims",
  persistentVolumes: "PersistentVolumes",
  storageClasses: "StorageClasses",
  serviceAccounts: "ServiceAccounts",
  roles: "Roles",
  roleBindings: "RoleBindings",
  clusterRoles: "ClusterRoles",
  clusterRoleBindings: "ClusterRoleBindings",
  gatewayClasses: "GatewayClasses",
  gateways: "Gateways",
  httpRoutes: "HTTPRoutes",
  grpcRoutes: "GRPCRoutes",
  referenceGrants: "ReferenceGrants",
  tlsRoutes: "TLSRoutes",
  tcpRoutes: "TCPRoutes",
  udpRoutes: "UDPRoutes",
  backendTLSPolicies: "BackendTLSPolicies",
  listenerSets: "ListenerSets",
  customResourceDefinitions: "CustomResourceDefinitions",
};

export const NAV: [string, ResourceKind[]][] = [
  ["Cluster", ["nodes", "namespaces", "events"]],
  [
    "Workloads",
    ["pods", "deployments", "replicaSets", "statefulSets", "daemonSets", "jobs", "cronJobs"],
  ],
  [
    "Network",
    ["services", "endpoints", "endpointSlices", "ingresses", "ingressClasses", "networkPolicies"],
  ],
  [
    "Config",
    [
      "configMaps",
      "secrets",
      "resourceQuotas",
      "limitRanges",
      "horizontalPodAutoscalers",
      "podDisruptionBudgets",
    ],
  ],
  ["Storage", ["persistentVolumeClaims", "persistentVolumes", "storageClasses"]],
  ["Access", ["serviceAccounts", "roles", "roleBindings", "clusterRoles", "clusterRoleBindings"]],
  [
    "Gateway",
    [
      "gatewayClasses",
      "gateways",
      "listenerSets",
      "httpRoutes",
      "grpcRoutes",
      "tlsRoutes",
      "tcpRoutes",
      "udpRoutes",
      "backendTLSPolicies",
      "referenceGrants",
    ],
  ],
];

const GATEWAY_PLURAL: Partial<Record<ResourceKind, string>> = {
  gatewayClasses: "gatewayclasses",
  gateways: "gateways",
  listenerSets: "listenersets",
  httpRoutes: "httproutes",
  grpcRoutes: "grpcroutes",
  tlsRoutes: "tlsroutes",
  tcpRoutes: "tcproutes",
  udpRoutes: "udproutes",
  backendTLSPolicies: "backendtlspolicies",
  referenceGrants: "referencegrants",
};

const CLUSTER_SCOPED = new Set<ResourceKind>([
  "nodes",
  "namespaces",
  "ingressClasses",
  "persistentVolumes",
  "storageClasses",
  "clusterRoles",
  "clusterRoleBindings",
  "customResourceDefinitions",
  "gatewayClasses",
]);

export function isNamespaced(kind: ResourceKind): boolean {
  return !CLUSTER_SCOPED.has(kind);
}

export function supportsMetrics(kind: ResourceKind): boolean {
  return kind === "pods" || kind === "nodes";
}

export function hasValues(kind: ResourceKind): boolean {
  return kind === "configMaps" || kind === "secrets";
}

export function isSecret(kind: ResourceKind): boolean {
  return kind === "secrets";
}

export function canRestart(kind: ResourceKind): boolean {
  return kind === "deployments" || kind === "statefulSets" || kind === "daemonSets" || kind === "pods";
}

export function canForward(kind: ResourceKind): boolean {
  return kind === "pods" || kind === "services";
}

export function canExec(kind: ResourceKind): boolean {
  return kind === "pods";
}

export function canLogs(kind: ResourceKind): boolean {
  return (
    kind === "pods" ||
    kind === "deployments" ||
    kind === "replicaSets" ||
    kind === "statefulSets" ||
    kind === "daemonSets" ||
    kind === "jobs"
  );
}

export function installedGateway(targets: CrTarget[]): ResourceKind[] {
  const kinds = NAV.find(([title]) => title === "Gateway")?.[1] ?? [];
  return kinds.filter((kind) => {
    const plural = GATEWAY_PLURAL[kind];
    return (
      plural != null &&
      targets.some((target) => target.group === "gateway.networking.k8s.io" && target.plural === plural)
    );
  });
}

export function crGroups(targets: CrTarget[]): [string, CrTarget[]][] {
  const groups = new Map<string, CrTarget[]>();
  for (const target of targets) {
    if (target.group === "gateway.networking.k8s.io") continue;
    const list = groups.get(target.group) ?? [];
    list.push(target);
    groups.set(target.group, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.kind.localeCompare(b.kind) || a.version.localeCompare(b.version));
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function argoInstalled(targets: CrTarget[]): boolean {
  return targets.some((target) => target.group === "argoproj.io" && target.kind === "Application");
}

export function logTitle(kind: ResourceKind, namespace: string, name: string): string {
  return namespace ? `${TITLES[kind]} ${name}` : name;
}

export function viewTitle(view: View): string {
  if (view.kind === "overview") return "Overview";
  if (view.kind === "argo") return "Argo CD";
  if (view.kind === "resource") return TITLES[view.resource];
  return view.target.kind;
}

export type SearchHit = {
  view: View;
  label: string;
  hint: string;
  /** Namespace the view should open in, when the query pins one. */
  namespace: string | null;
};

export type SearchPlan = {
  hits: SearchHit[];
  /** The query text without the namespace part. */
  text: string;
  /** Exact namespace pinning the query, if any. */
  namespace: string | null;
  /** Namespace fragment the user is still typing (`pods kube-sys`). */
  namespacePrefix: string | null;
};

type RawHit = { view: View; label: string; hint: string };

/** `pods -n kube-system` and `pods --namespace=kube` also pin a namespace. */
const NAMESPACE_FLAG = /^(.*?)\s+(?:-n|--namespace)[=\s]+(\S*)$/;

function contains(haystack: string, needle: string): boolean {
  return needle === "" || haystack.toLowerCase().includes(needle);
}

function viewNamespaced(view: View): boolean {
  if (view.kind === "resource") return isNamespaced(view.resource);
  if (view.kind === "custom") return view.target.namespaced;
  return false;
}

function matchResources(needle: string, targets: CrTarget[]): RawHit[] {
  const hits: RawHit[] = [];
  if (needle === "" || "overview".includes(needle)) {
    hits.push({ view: { kind: "overview" }, label: "Overview", hint: "" });
  }
  if (argoInstalled(targets) && (needle === "" || "argo cd".includes(needle) || "argocd".includes(needle))) {
    hits.push({ view: { kind: "argo" }, label: "Argo CD", hint: "" });
  }
  for (const [title, kinds] of NAV) {
    const shown = title === "Gateway" ? installedGateway(targets) : kinds;
    for (const kind of shown) {
      if (contains(TITLES[kind], needle) || contains(title, needle)) {
        hits.push({ view: { kind: "resource", resource: kind }, label: TITLES[kind], hint: title });
      }
    }
  }
  if (needle === "" || "definitions".includes(needle) || "customresourcedefinitions".includes(needle)) {
    hits.push({
      view: { kind: "resource", resource: "customResourceDefinitions" },
      label: "Definitions",
      hint: "Custom Resources",
    });
  }
  for (const target of targets) {
    if (contains(target.kind, needle) || contains(target.group, needle)) {
      hits.push({ view: { kind: "custom", target }, label: target.kind, hint: target.group });
    }
  }
  return hits;
}

function decorate(hits: RawHit[], namespace: string | null, prefix: string | null): SearchHit[] {
  return hits.map((hit) => {
    const scoped = viewNamespaced(hit.view);
    const pinned = scoped ? namespace : null;
    const pending = pinned == null && scoped ? prefix : null;
    const shown = pinned ?? pending;
    return {
      view: hit.view,
      label: hit.label,
      hint: shown == null ? hit.hint : hit.hint === "" ? shown : `${hit.hint} · ${shown}`,
      namespace: pinned,
    };
  });
}

function namespaceFragment(namespaces: string[], fragment: string): string | null {
  if (fragment === "") return null;
  const lower = fragment.toLowerCase();
  return namespaces.some((name) => name.toLowerCase().startsWith(lower)) ? fragment : null;
}

function completeNamespace(fragment: string, namespaces: string[]): string | null {
  const lower = fragment.toLowerCase();
  const names = namespaces.filter((name) => name.toLowerCase().startsWith(lower)).sort();
  return names.find((name) => name === fragment) ?? names[0] ?? null;
}

/**
 * Splits `pods kube-system` into a resource query and a namespace. The trailing
 * bare token only counts as a namespace when the query as a whole matches
 * nothing, so multi-word resources like `argo cd` keep working.
 */
export function planSearch(query: string, targets: CrTarget[], namespaces: string[] = []): SearchPlan {
  const trimmed = query.trim();
  const flag = NAMESPACE_FLAG.exec(trimmed);
  if (flag) {
    const text = flag[1];
    const fragment = flag[2];
    // An explicit `-n` is a namespace request: resolve a prefix, otherwise take it as typed.
    const exact = namespaces.includes(fragment) ? fragment : null;
    const resolved = exact ?? completeNamespace(fragment, namespaces) ?? (fragment === "" ? null : fragment);
    const prefix = resolved === fragment ? null : namespaceFragment(namespaces, fragment);
    return {
      hits: decorate(matchResources(text.toLowerCase(), targets), resolved, prefix),
      text,
      namespace: resolved,
      namespacePrefix: prefix,
    };
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 1) {
    const tail = tokens[tokens.length - 1];
    const head = tokens.slice(0, -1).join(" ");
    const exact = namespaces.includes(tail) ? tail : null;
    const prefix = exact == null ? namespaceFragment(namespaces, tail) : null;
    if ((exact != null || prefix != null) && matchResources(trimmed.toLowerCase(), targets).length === 0) {
      return {
        hits: decorate(matchResources(head.toLowerCase(), targets), exact, prefix),
        text: head,
        namespace: exact,
        namespacePrefix: prefix,
      };
    }
  }
  return {
    hits: decorate(matchResources(trimmed.toLowerCase(), targets), null, null),
    text: trimmed,
    namespace: null,
    namespacePrefix: null,
  };
}

export function searchHits(query: string, targets: CrTarget[], namespaces: string[] = []): SearchHit[] {
  return planSearch(query, targets, namespaces).hits;
}

/**
 * Tab completion. `selected` is the label of the highlighted list entry, so the
 * result follows the cursor rather than the first hit. Without it the resource
 * name is finished from the current text, then the namespace once the query has
 * moved past it.
 */
export function completeSearch(
  query: string,
  targets: CrTarget[],
  namespaces: string[] = [],
  selected?: string | null,
): string | null {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  const plan = planSearch(query, targets, namespaces);
  if (plan.namespacePrefix != null) {
    const best = completeNamespace(plan.namespacePrefix, namespaces);
    if (best == null || best === plan.namespacePrefix) return null;
    return `${plan.text} ${best}`;
  }
  const label = (selected ?? "").toLowerCase();
  if (label === "") {
    const lower = trimmed.toLowerCase();
    for (const hit of plan.hits) {
      const name = hit.label.toLowerCase();
      if (name !== lower && name.startsWith(lower)) return `${name} `;
    }
    return null;
  }
  const text = plan.text.toLowerCase();
  if (label === text) return null;
  return plan.namespace == null ? `${label} ` : `${label} ${plan.namespace}`;
}
