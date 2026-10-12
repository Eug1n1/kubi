export type ResourceKind =
  | "nodes"
  | "namespaces"
  | "events"
  | "pods"
  | "deployments"
  | "replicaSets"
  | "statefulSets"
  | "daemonSets"
  | "jobs"
  | "cronJobs"
  | "services"
  | "endpoints"
  | "endpointSlices"
  | "ingresses"
  | "ingressClasses"
  | "networkPolicies"
  | "configMaps"
  | "secrets"
  | "resourceQuotas"
  | "limitRanges"
  | "horizontalPodAutoscalers"
  | "podDisruptionBudgets"
  | "persistentVolumeClaims"
  | "persistentVolumes"
  | "storageClasses"
  | "serviceAccounts"
  | "roles"
  | "roleBindings"
  | "clusterRoles"
  | "clusterRoleBindings"
  | "gatewayClasses"
  | "gateways"
  | "httpRoutes"
  | "grpcRoutes"
  | "referenceGrants"
  | "tlsRoutes"
  | "tcpRoutes"
  | "udpRoutes"
  | "backendTLSPolicies"
  | "listenerSets"
  | "customResourceDefinitions";

export type StatusTone = "ok" | "warn" | "bad" | "neutral";

export type ContextInfo = {
  name: string;
  cluster: string;
  namespace: string | null;
  current: boolean;
};

export type ResourceRow = {
  uid: string;
  name: string;
  namespace: string;
  status: string;
  tone: StatusTone;
  ready: string;
  ageSecs: number;
  info: string;
  cells: Record<string, string>;
  labels: [string, string][];
  annotations: [string, string][];
  cpuMillis: number | null;
  cpuRequestMillis: number | null;
  memBytes: number | null;
  memRequestBytes: number | null;
};

export type CrTarget = {
  name: string;
  kind: string;
  group: string;
  version: string;
  plural: string;
  namespaced: boolean;
};

export type WatchTarget = { kind: ResourceKind } | { custom: CrTarget };

export type UsageSample = {
  namespace: string;
  name: string;
  cpuMillis: number;
  memBytes: number;
};

export type DataEntry = {
  key: string;
  value: string;
  masked: boolean;
  binary: boolean;
};

export type OverviewWarning = {
  object: string;
  reason: string;
  message: string;
  ageSecs: number;
};

export type ArgoApp = {
  name: string;
  namespace: string;
  project: string;
  health: string;
  sync: string;
};

export type ArgoAppSet = {
  name: string;
  namespace: string;
  applications: number;
  status: string;
};

export type ArgoRepo = {
  name: string;
  url: string;
  repoType: string;
  project: string;
};

export type ArgoCluster = {
  name: string;
  server: string;
};

export type ArgoOverview = {
  target: CrTarget;
  apps: ArgoApp[];
  appSets: ArgoAppSet[];
  setsTarget: CrTarget | null;
  repos: ArgoRepo[];
  clusters: ArgoCluster[];
  note: string | null;
  setsNote: string | null;
  reposNote: string | null;
  clustersNote: string | null;
};

export type ClusterOverview = {
  context: string;
  nodesReady: number;
  nodesTotal: number;
  pods: number;
  podsRunning: number;
  podsPending: number;
  podsFailed: number;
  podsSucceeded: number;
  podsUnknown: number;
  namespaces: number;
  warningEvents: number | null;
  warnings: OverviewWarning[];
  cpuMillis: number | null;
  cpuAllocatableMillis: number | null;
  memBytes: number | null;
  memAllocatableBytes: number | null;
  note: string | null;
  argo: ArgoOverview | null;
};

export type Command =
  | "loadContexts"
  | "stopWatch"
  | "fetchOverview"
  | "refreshCatalog"
  | { setKubeconfig: { path: string } }
  | { connect: { context: string } }
  | { setNamespace: { namespace: string | null } }
  | { watch: { target: WatchTarget } }
  | {
      fetchYaml: {
        target: WatchTarget;
        namespace: string;
        name: string;
        uid: string;
        revealSecrets: boolean;
      };
    }
  | { delete: { target: WatchTarget; namespace: string; name: string } }
  | { restart: { kind: ResourceKind; namespace: string; name: string } }
  | {
      startLogs: {
        id: number;
        kind: ResourceKind;
        namespace: string;
        name: string;
        pod: string | null;
        container: string | null;
        /** Stream the previous terminated container instance. */
        previous: boolean;
        /** Ask the API server to prefix every line with an RFC3339 timestamp. */
        timestamps: boolean;
      };
    }
  | { stopLog: { id: number } }
  | "stopLogs"
  | { apply: { yaml: string; namespace: string | null } }
  | {
      startPortForward: {
        id: number;
        namespace: string;
        name: string;
        kind: ResourceKind;
        localPort: number;
        remotePort: number;
      };
    }
  | { stopPortForward: { id: number } }
  | "stopPortForwards"
  | { startExec: { id: number; namespace: string; name: string; container: string | null } }
  | { execInput: { id: number; data: string } }
  | { execResize: { id: number; cols: number; rows: number } }
  | { stopExec: { id: number } }
  | "stopExecs";

export type AppEvent =
  | { contexts: ContextInfo[] }
  | {
      connected: {
        context: string;
        namespaces: string[];
        defaultNamespace: string | null;
      };
    }
  | { error: string }
  | { rows: { target: WatchTarget; rows: ResourceRow[] } }
  | { customResources: { context: string; targets: CrTarget[] } }
  | { usage: { kind: ResourceKind; samples: UsageSample[] } }
  | { metricsUnavailable: { kind: ResourceKind; message: string } }
  | { yaml: { uid: string; yaml: string } }
  | { objectData: { uid: string; entries: DataEntry[] } }
  | { applyResult: { error: string | null } }
  | { overview: ClusterOverview }
  | {
      logStarted: {
        id: number;
        namespace: string;
        name: string;
        pods: string[];
        pod: string;
        containers: string[];
        container: string;
      };
    }
  | { logLine: { id: number; line: string } }
  | { logClosed: { id: number } }
  | {
      portForwardStarted: {
        id: number;
        namespace: string;
        name: string;
        localPort: number;
        remotePort: number;
      };
    }
  | { portForwardClosed: { id: number } }
  | {
      execStarted: {
        id: number;
        namespace: string;
        name: string;
        container: string;
        containers: string[];
      };
    }
  | { execData: { id: number; text: string } }
  | { execClosed: { id: number } };

export type View =
  | { kind: "overview" }
  | { kind: "argo" }
  | { kind: "resource"; resource: ResourceKind }
  | { kind: "custom"; target: CrTarget };

export type DetailTab = "overview" | "yaml" | "metrics" | "data";

export type LogSnapshot = {
  kind: ResourceKind;
  namespace: string;
  name: string;
  pods: string[];
  pod: string;
  containers: string[];
  container: string;
  lines: string[];
  started: boolean;
  closed: boolean;
  /** Showing the logs of the previous terminated container instance. */
  previous: boolean;
  /** The API server prefixes every line with an RFC3339 timestamp. */
  timestamps: boolean;
};

export type LogsView = LogSnapshot & {
  id: number;
  /** Stable `log-<n>` window label. Stays put when a pod or container change allocates a new stream id. */
  label: string;
  /** True while this tab is shown in its own window instead of the drawer. */
  detached: boolean;
};

export type PortForward = {
  id: number;
  namespace: string;
  name: string;
  localPort: number;
  remotePort: number;
};

export type ForwardDraft = {
  namespace: string;
  name: string;
  kind: ResourceKind;
  localPort: string;
  remotePort: string;
};

export type ExecSnapshot = {
  id: number;
  namespace: string;
  name: string;
  containers: string[];
  container: string;
  text: string;
  closed: boolean;
};

export type DockLog = LogsView & { pane: "log" };

export type DockExec = ExecSnapshot & {
  pane: "exec";
  /** Stable `exec-<n>` window label. Stays put when a container change allocates a new session id. */
  label: string;
  /** True while this tab is shown in its own window instead of the drawer. */
  detached: boolean;
};

export type DockTab = DockLog | DockExec;

export type RowMenu = {
  x: number;
  y: number;
  uid: string;
};

export type Tab = {
  id: number;
  view: View;
  rows: ResourceRow[];
  selected: string | null;
  /** Every highlighted row. Includes `selected` when a row is focused. */
  selection: string[];
  /** Last plain click. Shift extends from here through the visible order. */
  anchor: string | null;
  detailTab: DetailTab;
  yaml: string | null;
  yamlFor: string | null;
  reveal: boolean;
  waiting: boolean;
  filter: string;
  sortKey: string;
  sortAsc: boolean;
  namespace: string | null;
  data: DataEntry[] | null;
  dataFor: string | null;
  observedAt: number | null;
};

export type Home = "cluster" | "argo";

export type PendingDelete = {
  title: string;
  target: WatchTarget;
  items: { namespace: string; name: string }[];
};

export type PendingSelect = {
  target: WatchTarget;
  namespace: string;
  name: string;
};

export function eventKey(event: AppEvent): string {
  return Object.keys(event)[0] ?? "";
}

export function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameTarget(a: WatchTarget, b: WatchTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function watchOf(view: View): WatchTarget | null {
  if (view.kind === "resource") return { kind: view.resource };
  if (view.kind === "custom") return { custom: view.target };
  return null;
}
