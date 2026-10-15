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

/** A folder the user made in the context rail. A context lives in one folder at most. */
export type ContextGroup = {
  id: string;
  name: string;
  contexts: string[];
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

/** One key/value pair a pod receives from a ConfigMap or Secret. */
export type PodValue = {
  key: string;
  value: string;
  masked: boolean;
  binary: boolean;
};

/** Where one container mounts a volume, and what backs it. */
export type PodMount = {
  container: string;
  name: string;
  path: string;
  readOnly: boolean;
  subPath: string | null;
  source: string;
  values: PodValue[];
  note: string | null;
};

/** One environment variable of one container, with its origin. */
export type PodEnv = {
  container: string;
  name: string;
  origin: string;
  key: string | null;
  value: string;
  masked: boolean;
  binary: boolean;
  note: string | null;
};

/** One container of a pod: spec facts plus its live status. */
export type PodContainer = {
  name: string;
  image: string;
  /** True for init containers, listed after the regular ones. */
  init: boolean;
  /** `8080/TCP http` style labels, in spec order. */
  ports: string[];
  /** `Running`, `Waiting: CrashLoopBackOff`, `Terminated: Error`, `Pending`. */
  state: string;
  ready: boolean;
  restarts: number;
  /** Resource name to quantity text, e.g. cpu: 50m. */
  requests: Record<string, string>;
  limits: Record<string, string>;
  env: PodEnv[];
  mounts: PodMount[];
};

export type PodSources = {
  mounts: PodMount[];
  env: PodEnv[];
};

/** Warning events of one object, for the badge in the object list. */
export type ObjectWarning = {
  uid: string;
  name: string;
  namespace: string;
  /** Reason of the most recent warning. */
  reason: string;
  count: number;
  ageSecs: number | null;
  /** True when nothing but probe failures was reported for the object. */
  probeOnly: boolean;
};

/** One event the cluster attached to the selected object. */
export type EventInfo = {
  /** `Normal` or `Warning`. */
  kind: string;
  reason: string;
  message: string;
  count: number;
  /** Null when the cluster reported no usable timestamp. */
  ageSecs: number | null;
  source: string;
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

/**
 * Every command that touches a cluster names the context it works on, so one
 * window can hold tabs for several clusters at once.
 */
export type Command =
  | "loadContexts"
  | "stopLogs"
  | "stopPortForwards"
  | "stopExecs"
  | { setKubeconfig: { path: string } }
  | { connect: { context: string } }
  | { setNamespace: { context: string; namespace: string | null } }
  | { watch: { context: string; target: WatchTarget } }
  | { stopWatch: { context: string } }
  | { fetchOverview: { context: string } }
  | { fetchEvents: { context: string; namespace: string; name: string; uid: string } }
  | { fetchWarnings: { context: string; namespace: string | null } }
  | {
      fetchPodSources: { context: string; namespace: string; name: string; uid: string; reveal: boolean };
    }
  | {
      fetchPodContainers: { context: string; namespace: string; name: string; uid: string; reveal: boolean };
    }
  | { refreshCatalog: { context: string } }
  | {
      fetchYaml: {
        context: string;
        target: WatchTarget;
        namespace: string;
        name: string;
        uid: string;
        revealSecrets: boolean;
      };
    }
  | { delete: { context: string; target: WatchTarget; namespace: string; name: string } }
  | { restart: { context: string; kind: ResourceKind; namespace: string; name: string } }
  | {
      startLogs: {
        context: string;
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
  | { apply: { context: string; yaml: string; namespace: string | null } }
  | {
      startPortForward: {
        context: string;
        id: number;
        namespace: string;
        name: string;
        kind: ResourceKind;
        localPort: number;
        remotePort: number;
      };
    }
  | { stopPortForward: { id: number } }
  | {
      startExec: {
        context: string;
        id: number;
        namespace: string;
        name: string;
        container: string | null;
      };
    }
  | { execInput: { id: number; data: string } }
  | { execResize: { id: number; cols: number; rows: number } }
  | { stopExec: { id: number } };

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
  | { rows: { context: string; target: WatchTarget; rows: ResourceRow[] } }
  | { customResources: { context: string; targets: CrTarget[] } }
  | { usage: { context: string; kind: ResourceKind; samples: UsageSample[] } }
  | { metricsUnavailable: { context: string; kind: ResourceKind; message: string } }
  | { yaml: { context: string; uid: string; yaml: string } }
  | { objectData: { context: string; uid: string; entries: DataEntry[] } }
  | { objectEvents: { context: string; uid: string; events: EventInfo[] } }
  | { warnings: { context: string; namespace: string | null; objects: ObjectWarning[] } }
  | { podSources: { context: string; uid: string } & PodSources }
  | { podContainers: { context: string; uid: string; containers: PodContainer[] } }
  | { applyResult: { context: string; error: string | null } }
  | { overview: { context: string; overview: ClusterOverview } }
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

export type DetailTab = "overview" | "yaml" | "metrics" | "data" | "events" | "sources";

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
  /** Cluster this tab belongs to. Tabs of several clusters can be open at once. */
  context: string;
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
  events: EventInfo[] | null;
  eventsFor: string | null;
  sources: PodSources | null;
  sourcesFor: string | null;
  containers: PodContainer[] | null;
  containersFor: string | null;
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
