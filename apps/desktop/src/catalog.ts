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

export type SearchHit = { view: View; label: string; hint: string };

export function searchHits(query: string, targets: CrTarget[]): SearchHit[] {
  const needle = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  const contains = (haystack: string) => haystack.toLowerCase().includes(needle);
  if (needle === "" || "overview".includes(needle)) {
    hits.push({ view: { kind: "overview" }, label: "Overview", hint: "" });
  }
  if (argoInstalled(targets) && (needle === "" || "argo cd".includes(needle) || "argocd".includes(needle))) {
    hits.push({ view: { kind: "argo" }, label: "Argo CD", hint: "" });
  }
  for (const [title, kinds] of NAV) {
    const shown = title === "Gateway" ? installedGateway(targets) : kinds;
    for (const kind of shown) {
      if (needle === "" || contains(TITLES[kind]) || contains(title)) {
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
    if (needle === "" || contains(target.kind) || contains(target.group)) {
      hits.push({
        view: { kind: "custom", target },
        label: target.kind,
        hint: target.group,
      });
    }
  }
  return hits;
}
