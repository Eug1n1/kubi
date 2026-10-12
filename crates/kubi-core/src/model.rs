use std::collections::BTreeMap;
use std::path::PathBuf;

/// Sidebar resource groups.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    Nodes,
    Namespaces,
    Events,
    Pods,
    Deployments,
    ReplicaSets,
    StatefulSets,
    DaemonSets,
    Jobs,
    CronJobs,
    Services,
    Endpoints,
    EndpointSlices,
    Ingresses,
    IngressClasses,
    NetworkPolicies,
    ConfigMaps,
    Secrets,
    ResourceQuotas,
    LimitRanges,
    HorizontalPodAutoscalers,
    PodDisruptionBudgets,
    PersistentVolumeClaims,
    PersistentVolumes,
    StorageClasses,
    ServiceAccounts,
    Roles,
    RoleBindings,
    ClusterRoles,
    ClusterRoleBindings,
    GatewayClasses,
    Gateways,
    HttpRoutes,
    GrpcRoutes,
    ReferenceGrants,
    TlsRoutes,
    TcpRoutes,
    UdpRoutes,
    BackendTLSPolicies,
    ListenerSets,
    CustomResourceDefinitions,
}

impl ResourceKind {
    pub fn title(self) -> &'static str {
        match self {
            Self::Nodes => "Nodes",
            Self::Namespaces => "Namespaces",
            Self::Events => "Events",
            Self::Pods => "Pods",
            Self::Deployments => "Deployments",
            Self::ReplicaSets => "ReplicaSets",
            Self::StatefulSets => "StatefulSets",
            Self::DaemonSets => "DaemonSets",
            Self::Jobs => "Jobs",
            Self::CronJobs => "CronJobs",
            Self::Services => "Services",
            Self::Endpoints => "Endpoints",
            Self::EndpointSlices => "EndpointSlices",
            Self::Ingresses => "Ingresses",
            Self::IngressClasses => "IngressClasses",
            Self::NetworkPolicies => "NetworkPolicies",
            Self::ConfigMaps => "ConfigMaps",
            Self::Secrets => "Secrets",
            Self::ResourceQuotas => "ResourceQuotas",
            Self::LimitRanges => "LimitRanges",
            Self::HorizontalPodAutoscalers => "HorizontalPodAutoscalers",
            Self::PodDisruptionBudgets => "PodDisruptionBudgets",
            Self::PersistentVolumeClaims => "PersistentVolumeClaims",
            Self::PersistentVolumes => "PersistentVolumes",
            Self::StorageClasses => "StorageClasses",
            Self::ServiceAccounts => "ServiceAccounts",
            Self::Roles => "Roles",
            Self::RoleBindings => "RoleBindings",
            Self::ClusterRoles => "ClusterRoles",
            Self::ClusterRoleBindings => "ClusterRoleBindings",
            Self::GatewayClasses => "GatewayClasses",
            Self::Gateways => "Gateways",
            Self::HttpRoutes => "HTTPRoutes",
            Self::GrpcRoutes => "GRPCRoutes",
            Self::ReferenceGrants => "ReferenceGrants",
            Self::TlsRoutes => "TLSRoutes",
            Self::TcpRoutes => "TCPRoutes",
            Self::UdpRoutes => "UDPRoutes",
            Self::BackendTLSPolicies => "BackendTLSPolicies",
            Self::ListenerSets => "ListenerSets",
            Self::CustomResourceDefinitions => "CustomResourceDefinitions",
        }
    }

    pub fn supports_metrics(self) -> bool {
        matches!(self, Self::Pods | Self::Nodes)
    }

    pub fn is_secret(self) -> bool {
        matches!(self, Self::Secrets)
    }

    pub fn has_values(self) -> bool {
        matches!(self, Self::ConfigMaps | Self::Secrets)
    }

    /// `(apiVersion, kind)` used when creating an object of this type.
    pub fn manifest(self) -> (&'static str, &'static str) {
        match self {
            Self::Nodes => ("v1", "Node"),
            Self::Namespaces => ("v1", "Namespace"),
            Self::Events => ("v1", "Event"),
            Self::Pods => ("v1", "Pod"),
            Self::Deployments => ("apps/v1", "Deployment"),
            Self::ReplicaSets => ("apps/v1", "ReplicaSet"),
            Self::StatefulSets => ("apps/v1", "StatefulSet"),
            Self::DaemonSets => ("apps/v1", "DaemonSet"),
            Self::Jobs => ("batch/v1", "Job"),
            Self::CronJobs => ("batch/v1", "CronJob"),
            Self::Services => ("v1", "Service"),
            Self::Endpoints => ("v1", "Endpoints"),
            Self::EndpointSlices => ("discovery.k8s.io/v1", "EndpointSlice"),
            Self::Ingresses => ("networking.k8s.io/v1", "Ingress"),
            Self::IngressClasses => ("networking.k8s.io/v1", "IngressClass"),
            Self::NetworkPolicies => ("networking.k8s.io/v1", "NetworkPolicy"),
            Self::ConfigMaps => ("v1", "ConfigMap"),
            Self::Secrets => ("v1", "Secret"),
            Self::ResourceQuotas => ("v1", "ResourceQuota"),
            Self::LimitRanges => ("v1", "LimitRange"),
            Self::HorizontalPodAutoscalers => ("autoscaling/v2", "HorizontalPodAutoscaler"),
            Self::PodDisruptionBudgets => ("policy/v1", "PodDisruptionBudget"),
            Self::PersistentVolumeClaims => ("v1", "PersistentVolumeClaim"),
            Self::PersistentVolumes => ("v1", "PersistentVolume"),
            Self::StorageClasses => ("storage.k8s.io/v1", "StorageClass"),
            Self::ServiceAccounts => ("v1", "ServiceAccount"),
            Self::Roles => ("rbac.authorization.k8s.io/v1", "Role"),
            Self::RoleBindings => ("rbac.authorization.k8s.io/v1", "RoleBinding"),
            Self::ClusterRoles => ("rbac.authorization.k8s.io/v1", "ClusterRole"),
            Self::ClusterRoleBindings => ("rbac.authorization.k8s.io/v1", "ClusterRoleBinding"),
            Self::GatewayClasses => ("gateway.networking.k8s.io/v1", "GatewayClass"),
            Self::Gateways => ("gateway.networking.k8s.io/v1", "Gateway"),
            Self::HttpRoutes => ("gateway.networking.k8s.io/v1", "HTTPRoute"),
            Self::GrpcRoutes => ("gateway.networking.k8s.io/v1", "GRPCRoute"),
            Self::ReferenceGrants => ("gateway.networking.k8s.io/v1beta1", "ReferenceGrant"),
            Self::TlsRoutes => ("gateway.networking.k8s.io/v1", "TLSRoute"),
            Self::TcpRoutes => ("gateway.networking.k8s.io/v1", "TCPRoute"),
            Self::UdpRoutes => ("gateway.networking.k8s.io/v1", "UDPRoute"),
            Self::BackendTLSPolicies => ("gateway.networking.k8s.io/v1", "BackendTLSPolicy"),
            Self::ListenerSets => ("gateway.networking.k8s.io/v1", "ListenerSet"),
            Self::CustomResourceDefinitions => {
                ("apiextensions.k8s.io/v1", "CustomResourceDefinition")
            }
        }
    }

    pub fn can_restart(self) -> bool {
        matches!(
            self,
            Self::Deployments | Self::StatefulSets | Self::DaemonSets
        )
    }

    pub fn gateway_plural(self) -> Option<&'static str> {
        Some(match self {
            Self::GatewayClasses => "gatewayclasses",
            Self::Gateways => "gateways",
            Self::ListenerSets => "listenersets",
            Self::HttpRoutes => "httproutes",
            Self::GrpcRoutes => "grpcroutes",
            Self::TlsRoutes => "tlsroutes",
            Self::TcpRoutes => "tcproutes",
            Self::UdpRoutes => "udproutes",
            Self::BackendTLSPolicies => "backendtlspolicies",
            Self::ReferenceGrants => "referencegrants",
            _ => return None,
        })
    }

    pub fn is_namespaced(self) -> bool {
        !matches!(
            self,
            Self::Nodes
                | Self::Namespaces
                | Self::IngressClasses
                | Self::PersistentVolumes
                | Self::StorageClasses
                | Self::ClusterRoles
                | Self::ClusterRoleBindings
                | Self::CustomResourceDefinitions
                | Self::GatewayClasses
        )
    }
}

impl std::fmt::Display for ResourceKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.title())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusTone {
    Ok,
    Warn,
    Bad,
    Neutral,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub namespace: Option<String>,
    pub current: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRow {
    pub uid: String,
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub tone: StatusTone,
    pub ready: String,
    pub age_secs: u64,
    pub info: String,
    pub cells: BTreeMap<String, String>,
    pub labels: Vec<(String, String)>,
    pub annotations: Vec<(String, String)>,
    pub cpu_millis: Option<f64>,
    pub cpu_request_millis: Option<f64>,
    pub mem_bytes: Option<f64>,
    pub mem_request_bytes: Option<f64>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSample {
    pub namespace: String,
    pub name: String,
    pub cpu_millis: f64,
    pub mem_bytes: f64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewWarning {
    pub object: String,
    pub reason: String,
    pub message: String,
    pub age_secs: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoApp {
    pub name: String,
    pub namespace: String,
    pub project: String,
    pub health: String,
    pub sync: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoAppSet {
    pub name: String,
    pub namespace: String,
    pub applications: u32,
    pub status: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoRepo {
    pub name: String,
    pub url: String,
    pub repo_type: String,
    pub project: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoCluster {
    pub name: String,
    pub server: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoOverview {
    pub target: CrTarget,
    pub apps: Vec<ArgoApp>,
    pub app_sets: Vec<ArgoAppSet>,
    pub sets_target: Option<CrTarget>,
    pub repos: Vec<ArgoRepo>,
    pub clusters: Vec<ArgoCluster>,
    pub note: Option<String>,
    pub sets_note: Option<String>,
    pub repos_note: Option<String>,
    pub clusters_note: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEntry {
    pub key: String,
    pub value: String,
    pub masked: bool,
    pub binary: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
    pub context: String,
    pub nodes_ready: u32,
    pub nodes_total: u32,
    pub pods: u32,
    pub pods_running: u32,
    pub pods_pending: u32,
    pub pods_failed: u32,
    pub pods_succeeded: u32,
    pub pods_unknown: u32,
    pub namespaces: u32,
    pub warning_events: Option<u32>,
    pub warnings: Vec<OverviewWarning>,
    pub cpu_millis: Option<f64>,
    pub cpu_allocatable_millis: Option<f64>,
    pub mem_bytes: Option<f64>,
    pub mem_allocatable_bytes: Option<f64>,
    pub note: Option<String>,
    pub argo: Option<ArgoOverview>,
}

pub fn usage_key(namespace: &str, name: &str) -> String {
    format!("{namespace}/{name}")
}

/// A custom resource served by one CRD. `name` is the CRD object name.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrTarget {
    pub name: String,
    pub kind: String,
    pub group: String,
    pub version: String,
    pub plural: String,
    pub namespaced: bool,
}

/// What the table and YAML fetch are watching.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchTarget {
    Kind(ResourceKind),
    Custom(CrTarget),
}

impl std::fmt::Display for WatchTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Kind(kind) => write!(f, "{kind}"),
            Self::Custom(target) => write!(f, "{}.{}", target.kind, target.group),
        }
    }
}

pub fn apply_usage(
    rows: &mut [ResourceRow],
    usage: &std::collections::HashMap<String, (f64, f64)>,
) {
    for row in rows {
        if let Some((cpu, mem)) = usage.get(&usage_key(&row.namespace, &row.name)) {
            row.cpu_millis = Some(*cpu);
            row.mem_bytes = Some(*mem);
        }
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    LoadContexts,
    SetKubeconfig {
        path: PathBuf,
    },
    Connect {
        context: String,
    },
    SetNamespace {
        namespace: Option<String>,
    },
    Watch {
        target: WatchTarget,
    },
    StopWatch,
    FetchYaml {
        target: WatchTarget,
        namespace: String,
        name: String,
        uid: String,
        reveal_secrets: bool,
    },
    FetchOverview,
    RefreshCatalog,
    Delete {
        target: WatchTarget,
        namespace: String,
        name: String,
    },
    Restart {
        kind: ResourceKind,
        namespace: String,
        name: String,
    },
    StartLogs {
        id: u64,
        kind: ResourceKind,
        namespace: String,
        name: String,
        pod: Option<String>,
        container: Option<String>,
    },
    StopLog {
        id: u64,
    },
    StopLogs,
    Apply {
        yaml: String,
        namespace: Option<String>,
    },
    StartPortForward {
        id: u64,
        namespace: String,
        name: String,
        kind: ResourceKind,
        local_port: u16,
        remote_port: u16,
    },
    StopPortForward {
        id: u64,
    },
    StopPortForwards,
    StartExec {
        id: u64,
        namespace: String,
        name: String,
        container: Option<String>,
    },
    ExecInput {
        id: u64,
        data: String,
    },
    ExecResize {
        id: u64,
        cols: u16,
        rows: u16,
    },
    StopExec {
        id: u64,
    },
    StopExecs,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AppEvent {
    Contexts(Vec<ContextInfo>),
    Connected {
        context: String,
        namespaces: Vec<String>,
        default_namespace: Option<String>,
    },
    Error(String),
    Rows {
        target: WatchTarget,
        rows: Vec<ResourceRow>,
    },
    CustomResources {
        context: String,
        targets: Vec<CrTarget>,
    },
    Usage {
        kind: ResourceKind,
        samples: Vec<UsageSample>,
    },
    MetricsUnavailable {
        kind: ResourceKind,
        message: String,
    },
    Yaml {
        uid: String,
        yaml: String,
    },
    ObjectData {
        uid: String,
        entries: Vec<DataEntry>,
    },
    ApplyResult {
        error: Option<String>,
    },
    Overview(Box<ClusterOverview>),
    LogStarted {
        id: u64,
        namespace: String,
        name: String,
        pods: Vec<String>,
        pod: String,
        containers: Vec<String>,
        container: String,
    },
    LogLine {
        id: u64,
        line: String,
    },
    LogClosed {
        id: u64,
    },
    PortForwardStarted {
        id: u64,
        namespace: String,
        name: String,
        local_port: u16,
        remote_port: u16,
    },
    PortForwardClosed {
        id: u64,
    },
    ExecStarted {
        id: u64,
        namespace: String,
        name: String,
        container: String,
        containers: Vec<String>,
    },
    ExecData {
        id: u64,
        text: String,
    },
    ExecClosed {
        id: u64,
    },
}

#[cfg(test)]
mod serde_tests {
    use super::*;

    #[test]
    fn command_and_kind_json_names() {
        assert_eq!(
            serde_json::to_value(Command::FetchOverview).unwrap(),
            serde_json::json!("fetchOverview")
        );
        assert_eq!(
            serde_json::to_value(ResourceKind::BackendTLSPolicies).unwrap(),
            serde_json::json!("backendTLSPolicies")
        );
        assert_eq!(
            serde_json::to_value(ResourceKind::HttpRoutes).unwrap(),
            serde_json::json!("httpRoutes")
        );
        let command = Command::FetchYaml {
            target: WatchTarget::Kind(ResourceKind::Pods),
            namespace: "default".into(),
            name: "app".into(),
            uid: "1".into(),
            reveal_secrets: true,
        };
        let value = serde_json::to_value(&command).unwrap();
        assert_eq!(value["fetchYaml"]["revealSecrets"], true);
        assert_eq!(value["fetchYaml"]["target"]["kind"], "pods");
        assert_eq!(
            serde_json::to_value(Command::StopLogs).unwrap(),
            serde_json::json!("stopLogs")
        );
        let logs = Command::StartLogs {
            id: 4,
            kind: ResourceKind::Deployments,
            namespace: "default".into(),
            name: "app".into(),
            pod: None,
            container: None,
        };
        let logs = serde_json::to_value(&logs).unwrap();
        assert_eq!(logs["startLogs"]["id"], 4);
        assert_eq!(logs["startLogs"]["kind"], "deployments");
        assert!(logs["startLogs"]["pod"].is_null());
        assert!(logs["startLogs"]["container"].is_null());
        assert_eq!(logs["startLogs"]["name"], "app");
        assert_eq!(
            serde_json::to_value(Command::StopLog { id: 4 }).unwrap()["stopLog"]["id"],
            4
        );
        assert_eq!(
            serde_json::to_value(Command::StopExecs).unwrap(),
            serde_json::json!("stopExecs")
        );
        assert_eq!(
            serde_json::to_value(Command::StopExec { id: 4 }).unwrap()["stopExec"]["id"],
            4
        );
    }
}
