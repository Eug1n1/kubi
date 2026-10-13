import type { ResourceKind, ResourceRow, View } from "./types";
import { isNamespaced } from "./catalog";
import { formatAge, formatBytesPair, formatCpuPair } from "./format";

export type Field =
  | "name"
  | "namespace"
  | "age"
  | "status"
  | "ready"
  | "info"
  | "cpu"
  | "memory"
  | { cell: string };

export type Col = {
  title: string;
  field: Field;
  colored: boolean;
  width: number;
};

function col(title: string, field: Field, colored: boolean, width: number): Col {
  return { title, field, colored, width };
}

function keyOf(field: Field): string {
  return typeof field === "string" ? field : `cell:${field.cell}`;
}

export function columnKey(field: Field): string {
  return keyOf(field);
}

/** Numbers read better right-aligned and in a monospace face. */
export function isNumericField(field: Field): boolean {
  if (field === "cpu" || field === "memory" || field === "age") return true;
  return typeof field === "object" && field.cell === "restarts";
}

export function columnsFor(view: View): Col[] {
  // Widths are weights: the table is fixed-layout, so a narrow window shrinks
  // columns proportionally and truncates instead of scrolling sideways.
  const cols: Col[] = [col("Name", "name", false, 300)];
  const namespaced = view.kind === "custom" ? view.target.namespaced : view.kind === "resource" ? isNamespaced(view.resource) : false;
  if (namespaced) cols.push(col("Namespace", "namespace", false, 112));
  const kind: ResourceKind | null = view.kind === "resource" ? view.resource : null;
  const middle = middleColumns(kind);
  let columns = 0;
  for (const [title, field, colored] of middle) {
    // Give the first two data columns more room than the trailing ones.
    const weight = field === "memory" ? 118 : field === "cpu" ? 112 : columns === 0 ? 150 : columns < 3 ? 74 : 96;
    columns += 1;
    cols.push(col(title, field, colored, weight));
  }
  cols.push(col("Age", "age", false, 60));
  return cols;
}

function middleColumns(kind: ResourceKind | null): [string, Field, boolean][] {
  switch (kind) {
    case "pods":
      return [
        ["Status", "status", true],
        ["Ready", "ready", false],
        ["Restarts", { cell: "restarts" }, false],
        ["Node", { cell: "node" }, false],
        ["CPU", "cpu", false],
        ["Memory", "memory", false],
      ];
    case "nodes":
      return [
        ["Status", "status", true],
        ["Roles", "info", false],
        ["Kubelet", "ready", false],
        ["CPU", "cpu", false],
        ["Memory", "memory", false],
      ];
    case "deployments":
    case "replicaSets":
    case "statefulSets":
    case "daemonSets":
      return [
        ["Status", "status", true],
        ["Ready", "ready", false],
      ];
    case "jobs":
      return [
        ["Status", "status", true],
        ["Completions", "ready", false],
      ];
    case "cronJobs":
      return [
        ["Schedule", "info", false],
        ["Suspend", "status", true],
        ["Active", "ready", false],
      ];
    case "services":
      return [
        ["Type", "status", false],
        ["Cluster IP", "ready", false],
        ["External IP", { cell: "externalIP" }, false],
        ["Ports", "info", false],
      ];
    case "endpoints":
      return [
        ["Status", "status", true],
        ["Addresses", "ready", false],
        ["Not ready", "info", false],
      ];
    case "endpointSlices":
      return [
        ["Address type", "status", false],
        ["Endpoints", "ready", false],
      ];
    case "ingresses":
      return [
        ["Class", "ready", false],
        ["Hosts", "info", false],
      ];
    case "ingressClasses":
      return [["Controller", "ready", false]];
    case "gatewayClasses":
      return [["Controller", { cell: "controller" }, false]];
    case "networkPolicies":
      return [
        ["Types", "ready", false],
        ["Rules", "info", false],
      ];
    case "configMaps":
      return [
        ["Keys", "ready", false],
        ["Data", "info", false],
      ];
    case "secrets":
      return [
        ["Keys", "ready", false],
        ["Type", "status", false],
      ];
    case "resourceQuotas":
      return [
        ["Used", "ready", false],
        ["Hard", "info", false],
      ];
    case "limitRanges":
      return [
        ["Limits", "ready", false],
        ["Types", "info", false],
      ];
    case "horizontalPodAutoscalers":
      return [
        ["Replicas", "ready", false],
        ["Target", "info", false],
      ];
    case "podDisruptionBudgets":
      return [
        ["Healthy", "ready", false],
        ["Budget", "info", false],
      ];
    case "persistentVolumeClaims":
    case "persistentVolumes":
      return [
        ["Phase", "status", true],
        ["Size", "ready", false],
        ["Class", { cell: "class" }, false],
      ];
    case "storageClasses":
      return [
        ["Provisioner", "info", false],
        ["Reclaim", "ready", false],
      ];
    case "serviceAccounts":
      return [
        ["Secrets", "ready", false],
        ["Pull secrets", "info", false],
      ];
    case "roles":
    case "clusterRoles":
      return [["Rules", "ready", false]];
    case "roleBindings":
    case "clusterRoleBindings":
      return [
        ["Subjects", "ready", false],
        ["Role", "info", false],
      ];
    case "namespaces":
      return [["Phase", "status", true]];
    case "events":
      return [
        ["Reason", { cell: "reason" }, true],
        ["Object", { cell: "object" }, false],
        ["Count", { cell: "count" }, false],
        ["Message", { cell: "message" }, false],
      ];
    case "customResourceDefinitions":
      return [
        ["Established", "status", true],
        ["Scope", "ready", false],
        ["Group", "info", false],
      ];
    case "gateways":
      return [
        ["Class", { cell: "class" }, false],
        ["Listeners", { cell: "listeners" }, false],
        ["Addresses", { cell: "addresses" }, false],
      ];
    case "httpRoutes":
    case "grpcRoutes":
    case "tlsRoutes":
      return [
        ["Hostnames", { cell: "hostnames" }, false],
        ["Parent", { cell: "parent" }, false],
      ];
    case "tcpRoutes":
    case "udpRoutes":
      return [
        ["Parent", { cell: "parent" }, false],
        ["Backends", { cell: "backends" }, false],
      ];
    case "backendTLSPolicies":
      return [
        ["Target", { cell: "target" }, false],
        ["Hostname", { cell: "hostname" }, false],
      ];
    case "referenceGrants":
      return [
        ["From", { cell: "from" }, false],
        ["To", { cell: "to" }, false],
      ];
    case "listenerSets":
      return [
        ["Gateway", { cell: "gateway" }, false],
        ["Listeners", { cell: "listeners" }, false],
      ];
    default:
      return [["Status", "status", true]];
  }
}

export function fieldText(row: ResourceRow, field: Field, ageSecs = row.ageSecs): string {
  let text = "";
  if (field === "name") text = row.name;
  else if (field === "namespace") text = row.namespace;
  else if (field === "age") text = formatAge(ageSecs);
  else if (field === "status") text = row.status;
  else if (field === "ready") text = row.ready;
  else if (field === "info") text = row.info;
  else if (field === "cpu") text = formatCpuPair(row.cpuMillis, row.cpuRequestMillis);
  else if (field === "memory") text = formatBytesPair(row.memBytes, row.memRequestBytes);
  else text = row.cells[field.cell] ?? "";
  return text === "" ? "-" : text;
}

export function compareRows(a: ResourceRow, b: ResourceRow, field: Field, asc: boolean): number {
  if (field === "age") {
    const order = a.ageSecs < b.ageSecs ? -1 : a.ageSecs > b.ageSecs ? 1 : 0;
    return asc ? order : -order;
  }
  const order = fieldText(a, field).localeCompare(fieldText(b, field));
  return asc ? order : -order;
}
