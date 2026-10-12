import type { CrTarget, ResourceKind, View } from "./types";
import { isNamespaced } from "./catalog";

const MANIFEST: Record<ResourceKind, [string, string]> = {
  nodes: ["v1", "Node"],
  namespaces: ["v1", "Namespace"],
  events: ["v1", "Event"],
  pods: ["v1", "Pod"],
  deployments: ["apps/v1", "Deployment"],
  replicaSets: ["apps/v1", "ReplicaSet"],
  statefulSets: ["apps/v1", "StatefulSet"],
  daemonSets: ["apps/v1", "DaemonSet"],
  jobs: ["batch/v1", "Job"],
  cronJobs: ["batch/v1", "CronJob"],
  services: ["v1", "Service"],
  endpoints: ["v1", "Endpoints"],
  endpointSlices: ["discovery.k8s.io/v1", "EndpointSlice"],
  ingresses: ["networking.k8s.io/v1", "Ingress"],
  ingressClasses: ["networking.k8s.io/v1", "IngressClass"],
  networkPolicies: ["networking.k8s.io/v1", "NetworkPolicy"],
  configMaps: ["v1", "ConfigMap"],
  secrets: ["v1", "Secret"],
  resourceQuotas: ["v1", "ResourceQuota"],
  limitRanges: ["v1", "LimitRange"],
  horizontalPodAutoscalers: ["autoscaling/v2", "HorizontalPodAutoscaler"],
  podDisruptionBudgets: ["policy/v1", "PodDisruptionBudget"],
  persistentVolumeClaims: ["v1", "PersistentVolumeClaim"],
  persistentVolumes: ["v1", "PersistentVolume"],
  storageClasses: ["storage.k8s.io/v1", "StorageClass"],
  serviceAccounts: ["v1", "ServiceAccount"],
  roles: ["rbac.authorization.k8s.io/v1", "Role"],
  roleBindings: ["rbac.authorization.k8s.io/v1", "RoleBinding"],
  clusterRoles: ["rbac.authorization.k8s.io/v1", "ClusterRole"],
  clusterRoleBindings: ["rbac.authorization.k8s.io/v1", "ClusterRoleBinding"],
  gatewayClasses: ["gateway.networking.k8s.io/v1", "GatewayClass"],
  gateways: ["gateway.networking.k8s.io/v1", "Gateway"],
  httpRoutes: ["gateway.networking.k8s.io/v1", "HTTPRoute"],
  grpcRoutes: ["gateway.networking.k8s.io/v1", "GRPCRoute"],
  referenceGrants: ["gateway.networking.k8s.io/v1beta1", "ReferenceGrant"],
  tlsRoutes: ["gateway.networking.k8s.io/v1", "TLSRoute"],
  tcpRoutes: ["gateway.networking.k8s.io/v1", "TCPRoute"],
  udpRoutes: ["gateway.networking.k8s.io/v1", "UDPRoute"],
  backendTLSPolicies: ["gateway.networking.k8s.io/v1", "BackendTLSPolicy"],
  listenerSets: ["gateway.networking.k8s.io/v1", "ListenerSet"],
  customResourceDefinitions: ["apiextensions.k8s.io/v1", "CustomResourceDefinition"],
};

function kindBody(kind: ResourceKind): string {
  switch (kind) {
    case "configMaps":
      return "data: {}\n";
    case "secrets":
      return "type: Opaque\nstringData: {}\n";
    case "pods":
      return "spec:\n  containers:\n    - name: app\n      image: nginx:1.27\n";
    case "deployments":
      return "spec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: example\n  template:\n    metadata:\n      labels:\n        app: example\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.27\n";
    case "services":
      return "spec:\n  selector:\n    app: example\n  ports:\n    - port: 80\n      targetPort: 80\n";
    default:
      return "";
  }
}

export function objectTemplate(view: View, namespace: string | null): string {
  const ns = namespace ?? "default";
  if (view.kind === "overview" || view.kind === "argo") return "";
  if (view.kind === "custom") return customTemplate(view.target, ns);
  const [api, name] = MANIFEST[view.resource];
  const namespaceLine = isNamespaced(view.resource) ? `  namespace: ${ns}\n` : "";
  return `apiVersion: ${api}\nkind: ${name}\nmetadata:\n  name: example\n${namespaceLine}${kindBody(view.resource)}`;
}

function customTemplate(target: CrTarget, namespace: string): string {
  const api = target.group === "" ? target.version : `${target.group}/${target.version}`;
  const namespaceLine = target.namespaced ? `  namespace: ${namespace}\n` : "";
  return `apiVersion: ${api}\nkind: ${target.kind}\nmetadata:\n  name: example\n${namespaceLine}`;
}
