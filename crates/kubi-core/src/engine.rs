use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use crate::metrics_types::{NodeMetrics, PodMetrics};
use futures::SinkExt;
use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Container, ContainerStatus, Endpoints, Event, KeyToPath, LimitRange, Namespace, Node,
    PersistentVolume, PersistentVolumeClaim, Pod, ResourceQuota, Secret, Service,
    ServiceAccount, Volume,
};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::api::networking::v1::{Ingress, IngressClass, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::api::storage::v1::StorageClass;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, ListParams, LogParams, ObjectList, Patch, PatchParams,
};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::core::{GroupVersionKind, NamespaceResourceScope};
use kube::discovery::{Discovery, Scope};
use kube::runtime::watcher::{self, watcher, Event as WatchEvent};
use kube::{Api, Client, Resource};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use crate::kubeconfig::{contexts_from, load_kubeconfig, namespace_of};
use crate::model::{
    AppEvent, ArgoApp, ArgoAppSet, ArgoCluster, ArgoOverview, ArgoRepo, ClusterOverview, Command,
    CrTarget, DataEntry, EventInfo, ObjectWarning, OverviewWarning, PodContainer, PodEnv, PodMount,
    PodValue,
    ResourceKind, UsageSample, WatchTarget,
};
use crate::quantity::{parse_bytes, parse_cpu_millis};
use crate::rows::{
    clusterrole_row, clusterrolebinding_row, configmap_row, crd_row, cronjob_row, daemonset_row,
    deployment_row, dynamic_row, endpoints_row, endpointslice_row, event_row, hpa_row, ingress_row,
    ingressclass_row, job_row, limitrange_row, namespace_row, networkpolicy_row, node_is_ready,
    node_row, node_usage, pdb_row, pod_row, pod_usage, pv_row, pvc_row, replicaset_row,
    resourcequota_row, role_row, rolebinding_row, secret_row, service_row, serviceaccount_row,
    statefulset_row, storageclass_row,
};

macro_rules! watch_ns {
    ($context:expr, $client:expr, $namespace:expr, $kind:expr, $ty:ty, $row:path, $cancel:expr, $events:expr) => {
        spawn_watch(
            namespaced::<$ty>($client, $namespace),
            WatchTarget::Kind($kind),
            $row,
            $cancel,
            $events,
            None,
            $context,
        );
    };
}

macro_rules! watch_cluster {
    ($context:expr, $client:expr, $kind:expr, $ty:ty, $row:path, $cancel:expr, $events:expr) => {
        spawn_watch(
            Api::<$ty>::all($client),
            WatchTarget::Kind($kind),
            $row,
            $cancel,
            $events,
            None,
            $context,
        );
    };
}

macro_rules! yaml_ns {
    ($client:expr, $namespace:expr, $name:expr, $ty:ty, $version:expr, $kind:expr) => {
        read_yaml(
            ns_api::<$ty>($client, $namespace),
            $name,
            $version,
            $kind,
            false,
        )
        .await
    };
}

macro_rules! yaml_cluster {
    ($client:expr, $name:expr, $ty:ty, $version:expr, $kind:expr) => {
        read_yaml(Api::<$ty>::all($client), $name, $version, $kind, false).await
    };
}
use crate::yaml;

pub struct CoreHandle {
    cmd_tx: UnboundedSender<Command>,
    event_rx: std::sync::mpsc::Receiver<AppEvent>,
}

/// Clone of the command channel. Safe to share with a UI thread while [`CoreHandle::recv`] blocks elsewhere.
#[derive(Clone)]
pub struct CoreSender(UnboundedSender<Command>);

impl CoreSender {
    pub fn send(&self, command: Command) {
        let _ = self.0.send(command);
    }
}

impl CoreHandle {
    pub fn spawn() -> Self {
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("kubi-core".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("failed to start tokio runtime");
                runtime.block_on(async move {
                    let mut engine = Engine::new(event_tx);
                    let mut cmd_rx = cmd_rx;
                    while let Some(command) = cmd_rx.recv().await {
                        engine.handle(command).await;
                    }
                });
            })
            .expect("failed to start kubi-core thread");
        Self { cmd_tx, event_rx }
    }

    pub fn send(&self, command: Command) {
        let _ = self.cmd_tx.send(command);
    }

    pub fn command_sender(&self) -> CoreSender {
        CoreSender(self.cmd_tx.clone())
    }

    /// Blocks until the core emits an event, or the core thread has stopped.
    pub fn recv(&self) -> Option<AppEvent> {
        self.event_rx.recv().ok()
    }

    pub fn drain(&self) -> Vec<AppEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.event_rx.try_recv() {
            events.push(event);
        }
        events
    }
}

struct Engine {
    events: std::sync::mpsc::Sender<AppEvent>,
    kubeconfig_path: Option<PathBuf>,
    /// One client per context: connecting to another cluster keeps this one.
    clients: std::collections::HashMap<String, Client>,
    /// Context the window is showing; new tabs and the sidebar follow it.
    context: Option<String>,
    /// Namespace scope per context, so each cluster keeps its own.
    namespaces: std::collections::HashMap<String, Option<String>>,
    /// Live watch per context: a list in one cluster keeps updating while the
    /// window looks at another.
    watches: std::collections::HashMap<String, CancellationToken>,
    /// Custom resource catalog per context.
    catalogs: std::collections::HashMap<String, CancellationToken>,
    logs: std::collections::HashMap<u64, LiveStream>,
    forwards: std::collections::HashMap<u64, LiveStream>,
    execs: std::collections::HashMap<u64, ExecSlot>,
    argo_cache: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, ArgoTargets>>>,
}

/// A stream that outlives the command that started it, with the cluster it
/// belongs to, so dropping one cluster stops only its streams.
struct LiveStream {
    context: String,
    cancel: CancellationToken,
}

struct ExecSlot {
    context: String,
    cancel: CancellationToken,
    input: tokio::sync::mpsc::UnboundedSender<ExecMsg>,
}

enum ExecMsg {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

#[derive(Clone)]
struct ArgoTargets {
    app: Option<crate::model::CrTarget>,
    set: Option<crate::model::CrTarget>,
}

impl Engine {
    fn new(events: std::sync::mpsc::Sender<AppEvent>) -> Self {
        Self {
            events,
            kubeconfig_path: None,
            clients: std::collections::HashMap::new(),
            context: None,
            namespaces: std::collections::HashMap::new(),
            watches: std::collections::HashMap::new(),
            catalogs: std::collections::HashMap::new(),
            logs: std::collections::HashMap::new(),
            forwards: std::collections::HashMap::new(),
            execs: std::collections::HashMap::new(),
            argo_cache: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    async fn handle(&mut self, command: Command) {
        match command {
            Command::LoadContexts => self.emit_contexts(),
            Command::SetKubeconfig { path } => {
                self.stop_watches();
                self.stop_catalogs();
                self.stop_logs();
                self.stop_forwards();
                self.stop_execs();
                self.clear_argo_cache();
                self.clients.clear();
                self.namespaces.clear();
                self.kubeconfig_path = Some(path);
                self.emit_contexts();
            }
            Command::Connect { context } => self.connect(context).await,
            Command::Disconnect { context } => self.disconnect(context),
            Command::SetNamespace { context, namespace } => {
                self.namespaces.insert(context, namespace);
            }
            Command::Watch { context, target } => match target {
                WatchTarget::Kind(kind) => self.start_watch(context, kind),
                WatchTarget::Custom(target) => self.start_custom_watch(context, target),
            },
            Command::StopWatch { context } => self.stop_watch(&context),
            Command::FetchYaml {
                context,
                target,
                namespace,
                name,
                uid,
                reveal_secrets,
            } => self.spawn_fetch(context, target, namespace, name, uid, reveal_secrets),
            Command::FetchOverview { context } => self.fetch_overview(context),
            Command::FetchEvents {
                context,
                namespace,
                name,
                uid,
            } => self.spawn_events(context, namespace, name, uid),
            Command::FetchWarnings { context, namespace } => {
                self.spawn_warnings(context, namespace)
            }
            Command::FetchPodSources {
                context,
                namespace,
                name,
                uid,
                reveal,
            } => self.spawn_pod_sources(context, namespace, name, uid, reveal),
            Command::FetchPodContainers {
                context,
                namespace,
                name,
                uid,
                reveal,
            } => self.spawn_pod_containers(context, namespace, name, uid, reveal),
            Command::RefreshCatalog { context } => self.start_catalog(&context),
            Command::Delete {
                context,
                target,
                namespace,
                name,
            } => self.spawn_delete(context, target, namespace, name),
            Command::Restart {
                context,
                kind,
                namespace,
                name,
            } => self.spawn_restart(context, kind, namespace, name),
            Command::StartLogs {
                context,
                id,
                kind,
                namespace,
                name,
                pod,
                container,
                previous,
                timestamps,
            } => self.start_logs(
                context,
                id,
                kind,
                namespace,
                name,
                pod,
                container,
                previous,
                timestamps,
            ),
            Command::StopLog { id } => self.stop_log(id),
            Command::StopLogs => self.stop_logs(),
            Command::Apply {
                context,
                yaml,
                namespace,
            } => self.spawn_apply(context, yaml, namespace),
            Command::StartPortForward {
                context,
                id,
                namespace,
                name,
                kind,
                local_port,
                remote_port,
            } => self.start_forward(context, id, namespace, name, kind, local_port, remote_port),
            Command::StopPortForward { id } => self.stop_forward(id),
            Command::StopPortForwards => self.stop_forwards(),
            Command::StartExec {
                context,
                id,
                namespace,
                name,
                container,
            } => self.start_exec(context, id, namespace, name, container),
            Command::ExecInput { id, data } => self.exec_input(id, data),
            Command::ExecResize { id, cols, rows } => self.exec_resize(id, cols, rows),
            Command::StopExec { id } => self.stop_exec(id),
            Command::StopExecs => self.stop_execs(),
        }
    }

    fn emit(&self, event: AppEvent) {
        let _ = self.events.send(event);
    }

    fn emit_error(&self, message: impl Into<String>) {
        self.emit(AppEvent::Error(message.into()));
    }

    fn emit_contexts(&self) {
        match load_kubeconfig(self.kubeconfig_path.as_deref()) {
            Ok(kubeconfig) => self.emit(AppEvent::Contexts(contexts_from(&kubeconfig))),
            Err(err) => self.emit_error(err),
        }
    }

    /// Connects to `context` and makes it the one the window shows. Other
    /// clusters keep their clients, watches and streams: that is why every
    /// command names the context it works on.
    async fn connect(&mut self, context: String) {
        let client = match build_client(self.kubeconfig_path.as_deref(), &context).await {
            Ok(client) => client,
            Err(err) => {
                self.emit_error(format!("connect {context}: {err}"));
                return;
            }
        };
        self.clients.insert(context.clone(), client.clone());
        self.context = Some(context.clone());
        let namespaces = match list_namespaces(&client).await {
            Ok(namespaces) => namespaces,
            Err(err) => {
                self.emit_error(err);
                Vec::new()
            }
        };
        let default_namespace = load_kubeconfig(self.kubeconfig_path.as_deref())
            .ok()
            .and_then(|kubeconfig| namespace_of(&kubeconfig, &context));
        self.namespaces
            .insert(context.clone(), default_namespace.clone());
        self.start_catalog(&context);
        self.emit(AppEvent::Connected {
            context,
            namespaces,
            default_namespace,
        });
    }

    /// Drops one cluster: its client, its watches, its catalog and its live
    /// sessions. Every other cluster keeps all of that, which is the point of
    /// naming a context on every command.
    fn disconnect(&mut self, context: String) {
        self.stop_watch(&context);
        self.stop_catalog(&context);
        self.stop_context_logs(&context);
        self.stop_context_forwards(&context);
        self.stop_context_execs(&context);
        self.clients.remove(&context);
        self.namespaces.remove(&context);
        if let Ok(mut cache) = self.argo_cache.lock() {
            cache.remove(&context);
        }
        if self.context.as_deref() == Some(context.as_str()) {
            self.context = None;
        }
        self.emit(AppEvent::Disconnected { context });
    }

    /// The client for one context, or `None` when it was never connected.
    fn client_for(&self, context: &str) -> Option<Client> {
        self.clients.get(context).cloned()
    }

    /// The client for one context, telling the UI when there is none.
    fn require_client(&self, context: &str) -> Option<Client> {
        match self.client_for(context) {
            Some(client) => Some(client),
            None => {
                self.emit_error(format!("Not connected to cluster {context}"));
                None
            }
        }
    }

    fn start_watch(&mut self, context: String, kind: ResourceKind) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        self.stop_watch(&context);
        let cancel = CancellationToken::new();
        self.watches.insert(context.clone(), cancel.clone());
        let namespace = self.namespaces.get(&context).cloned().flatten();
        let events = self.events.clone();
        match kind {
            ResourceKind::Pods => {
                spawn_watch(
                    namespaced::<Pod>(client.clone(), &namespace),
                    WatchTarget::Kind(kind),
                    pod_row,
                    cancel.clone(),
                    events.clone(),
                    None,
                    context.clone(),
                );
                spawn_metrics(context.clone(), kind, cancel, events, move || {
                    let client = client.clone();
                    let namespace = namespace.clone();
                    Box::pin(async move {
                        let api = namespaced::<PodMetrics>(client, &namespace);
                        let items = list_all(api).await?;
                        Ok(items.iter().filter_map(pod_usage).collect())
                    })
                });
            }
            ResourceKind::Nodes => {
                spawn_watch(
                    Api::<Node>::all(client.clone()),
                    WatchTarget::Kind(kind),
                    node_row,
                    cancel.clone(),
                    events.clone(),
                    None,
                    context.clone(),
                );
                spawn_metrics(context.clone(), kind, cancel, events, move || {
                    let client = client.clone();
                    Box::pin(async move {
                        let items = list_all(Api::<NodeMetrics>::all(client)).await?;
                        Ok(items.iter().filter_map(node_usage).collect())
                    })
                });
            }
            ResourceKind::Events => {
                watch_ns!(context.clone(), client, &namespace, kind, Event, event_row, cancel, events);
            }
            ResourceKind::Deployments => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    Deployment,
                    deployment_row,
                    cancel,
                    events
                );
            }
            ResourceKind::ReplicaSets => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    ReplicaSet,
                    replicaset_row,
                    cancel,
                    events
                );
            }
            ResourceKind::StatefulSets => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    StatefulSet,
                    statefulset_row,
                    cancel,
                    events
                );
            }
            ResourceKind::DaemonSets => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    DaemonSet,
                    daemonset_row,
                    cancel,
                    events
                );
            }
            ResourceKind::Jobs => {
                watch_ns!(context.clone(), client, &namespace, kind, Job, job_row, cancel, events);
            }
            ResourceKind::CronJobs => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    CronJob,
                    cronjob_row,
                    cancel,
                    events
                );
            }
            ResourceKind::Services => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    Service,
                    service_row,
                    cancel,
                    events
                );
            }
            ResourceKind::Endpoints => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    Endpoints,
                    endpoints_row,
                    cancel,
                    events
                );
            }
            ResourceKind::EndpointSlices => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    EndpointSlice,
                    endpointslice_row,
                    cancel,
                    events
                );
            }
            ResourceKind::Ingresses => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    Ingress,
                    ingress_row,
                    cancel,
                    events
                );
            }
            ResourceKind::NetworkPolicies => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    NetworkPolicy,
                    networkpolicy_row,
                    cancel,
                    events
                );
            }
            ResourceKind::ConfigMaps => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    ConfigMap,
                    configmap_row,
                    cancel,
                    events
                );
            }
            ResourceKind::Secrets => {
                watch_ns!(context.clone(), client, &namespace, kind, Secret, secret_row, cancel, events);
            }
            ResourceKind::ResourceQuotas => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    ResourceQuota,
                    resourcequota_row,
                    cancel,
                    events
                );
            }
            ResourceKind::LimitRanges => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    LimitRange,
                    limitrange_row,
                    cancel,
                    events
                );
            }
            ResourceKind::HorizontalPodAutoscalers => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    HorizontalPodAutoscaler,
                    hpa_row,
                    cancel,
                    events
                );
            }
            ResourceKind::PodDisruptionBudgets => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    PodDisruptionBudget,
                    pdb_row,
                    cancel,
                    events
                );
            }
            ResourceKind::PersistentVolumeClaims => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    PersistentVolumeClaim,
                    pvc_row,
                    cancel,
                    events
                );
            }
            ResourceKind::ServiceAccounts => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    ServiceAccount,
                    serviceaccount_row,
                    cancel,
                    events
                );
            }
            ResourceKind::Roles => {
                watch_ns!(context.clone(), client, &namespace, kind, Role, role_row, cancel, events);
            }
            ResourceKind::RoleBindings => {
                watch_ns!(context.clone(), 
                    client,
                    &namespace,
                    kind,
                    RoleBinding,
                    rolebinding_row,
                    cancel,
                    events
                );
            }
            ResourceKind::Namespaces => {
                watch_cluster!(context.clone(), client, kind, Namespace, namespace_row, cancel, events);
            }
            ResourceKind::IngressClasses => {
                watch_cluster!(context.clone(), client, kind, IngressClass, ingressclass_row, cancel, events);
            }
            ResourceKind::PersistentVolumes => {
                watch_cluster!(context.clone(), client, kind, PersistentVolume, pv_row, cancel, events);
            }
            ResourceKind::StorageClasses => {
                watch_cluster!(context.clone(), client, kind, StorageClass, storageclass_row, cancel, events);
            }
            ResourceKind::ClusterRoles => {
                watch_cluster!(context.clone(), client, kind, ClusterRole, clusterrole_row, cancel, events);
            }
            ResourceKind::ClusterRoleBindings => {
                watch_cluster!(context.clone(), 
                    client,
                    kind,
                    ClusterRoleBinding,
                    clusterrolebinding_row,
                    cancel,
                    events
                );
            }
            ResourceKind::CustomResourceDefinitions => {
                spawn_watch(
                    Api::<CustomResourceDefinition>::all(client),
                    WatchTarget::Kind(kind),
                    crd_row,
                    cancel,
                    events,
                    Some(5),
                    context.clone(),
                );
            }
            ResourceKind::GatewayClasses
            | ResourceKind::Gateways
            | ResourceKind::HttpRoutes
            | ResourceKind::GrpcRoutes
            | ResourceKind::TlsRoutes
            | ResourceKind::TcpRoutes
            | ResourceKind::UdpRoutes
            | ResourceKind::BackendTLSPolicies
            | ResourceKind::ListenerSets
            | ResourceKind::ReferenceGrants => {
                let (resource, namespaced) = gateway_api(kind);
                let api = dynamic_api(client, &resource, namespaced, &namespace);
                spawn_watch(
                    api,
                    WatchTarget::Kind(kind),
                    dynamic_row,
                    cancel,
                    events,
                    None,
                    context.clone(),
                );
            }
        }
    }

    fn start_custom_watch(&mut self, context: String, target: CrTarget) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        self.stop_watch(&context);
        let cancel = CancellationToken::new();
        self.watches.insert(context.clone(), cancel.clone());
        let resource = resource_of(&target.group, &target.version, &target.kind, &target.plural);
        let namespace = self.namespaces.get(&context).cloned().flatten();
        let api = dynamic_api(client, &resource, target.namespaced, &namespace);
        spawn_watch(
            api,
            WatchTarget::Custom(target),
            dynamic_row,
            cancel,
            self.events.clone(),
            None,
            context,
        );
    }

    /// Reads the CRDs a cluster serves. One catalog per context, so a custom
    /// resource list survives switching to another cluster.
    fn start_catalog(&mut self, context: &str) {
        self.stop_catalog(context);
        let Some(client) = self.client_for(context) else {
            return;
        };
        let cancel = CancellationToken::new();
        self.catalogs
            .insert(context.to_string(), cancel.clone());
        spawn_catalog(client, context.to_string(), cancel, self.events.clone());
    }

    fn stop_watch(&mut self, context: &str) {
        if let Some(token) = self.watches.remove(context) {
            token.cancel();
        }
    }

    fn stop_watches(&mut self) {
        for (_, token) in self.watches.drain() {
            token.cancel();
        }
    }

    fn stop_catalog(&mut self, context: &str) {
        if let Some(token) = self.catalogs.remove(context) {
            token.cancel();
        }
    }

    fn stop_catalogs(&mut self) {
        for (_, token) in self.catalogs.drain() {
            token.cancel();
        }
    }

    fn stop_log(&mut self, id: u64) {
        if let Some(stream) = self.logs.remove(&id) {
            stream.cancel.cancel();
        }
    }

    fn stop_logs(&mut self) {
        for (_, stream) in self.logs.drain() {
            stream.cancel.cancel();
        }
    }

    /// Ends the log streams of one cluster, leaving the other clusters alone.
    fn stop_context_logs(&mut self, context: &str) {
        let ids: Vec<u64> = self
            .logs
            .iter()
            .filter(|(_, stream)| stream.context == context)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.stop_log(id);
        }
    }

    fn clear_argo_cache(&self) {
        if let Ok(mut cache) = self.argo_cache.lock() {
            cache.clear();
        }
    }

    fn stop_forward(&mut self, id: u64) {
        if let Some(stream) = self.forwards.remove(&id) {
            stream.cancel.cancel();
        }
    }

    fn stop_forwards(&mut self) {
        for (_, stream) in self.forwards.drain() {
            stream.cancel.cancel();
        }
    }

    /// Ends the port forwards of one cluster, leaving the other clusters alone.
    fn stop_context_forwards(&mut self, context: &str) {
        let ids: Vec<u64> = self
            .forwards
            .iter()
            .filter(|(_, stream)| stream.context == context)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.stop_forward(id);
        }
    }

    fn start_forward(
        &mut self,
        context: String,
        id: u64,
        namespace: String,
        name: String,
        kind: ResourceKind,
        local_port: u16,
        remote_port: u16,
    ) {
        self.stop_forward(id);
        let Some(client) = self.require_client(&context) else {
            self.emit(AppEvent::PortForwardClosed { id });
            return;
        };
        if local_port == 0 || remote_port == 0 {
            self.emit_error("Port must be between 1 and 65535");
            self.emit(AppEvent::PortForwardClosed { id });
            return;
        }
        let cancel = CancellationToken::new();
        self.forwards.insert(
            id,
            LiveStream {
                context,
                cancel: cancel.clone(),
            },
        );
        let events = self.events.clone();
        tokio::spawn(async move {
            let result = forward_port(
                client,
                ForwardRequest {
                    id,
                    namespace,
                    name,
                    kind,
                    local_port,
                    remote_port,
                },
                cancel,
                events.clone(),
            )
            .await;
            if let Err(err) = result {
                let _ = events.send(AppEvent::Error(err));
            }
            let _ = events.send(AppEvent::PortForwardClosed { id });
        });
    }

    fn stop_exec(&mut self, id: u64) {
        if let Some(slot) = self.execs.remove(&id) {
            slot.cancel.cancel();
        }
    }

    fn stop_execs(&mut self) {
        for (_, slot) in self.execs.drain() {
            slot.cancel.cancel();
        }
    }

    /// Ends the shells of one cluster, leaving the other clusters alone.
    fn stop_context_execs(&mut self, context: &str) {
        let ids: Vec<u64> = self
            .execs
            .iter()
            .filter(|(_, slot)| slot.context == context)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.stop_exec(id);
        }
    }

    fn start_exec(
        &mut self,
        context: String,
        id: u64,
        namespace: String,
        name: String,
        container: Option<String>,
    ) {
        self.stop_exec(id);
        let Some(client) = self.require_client(&context) else {
            self.emit(AppEvent::ExecClosed { id });
            return;
        };
        let (input, input_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        self.execs.insert(
            id,
            ExecSlot {
                context,
                cancel: cancel.clone(),
                input,
            },
        );
        let events = self.events.clone();
        tokio::spawn(async move {
            if let Err(err) = run_exec(
                client,
                ExecRequest {
                    id,
                    namespace,
                    name,
                    container,
                },
                cancel,
                input_rx,
                events.clone(),
            )
            .await
            {
                let _ = events.send(AppEvent::Error(format!("exec: {err}")));
            }
            let _ = events.send(AppEvent::ExecClosed { id });
        });
    }

    fn exec_input(&self, id: u64, data: String) {
        if data.is_empty() {
            return;
        }
        let Some(slot) = self.execs.get(&id) else {
            return;
        };
        let _ = slot.input.send(ExecMsg::Data(data.into_bytes()));
    }

    fn exec_resize(&self, id: u64, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let Some(slot) = self.execs.get(&id) else {
            return;
        };
        let _ = slot.input.send(ExecMsg::Resize { cols, rows });
    }

    fn start_logs(
        &mut self,
        context: String,
        id: u64,
        kind: ResourceKind,
        namespace: String,
        name: String,
        pod: Option<String>,
        container: Option<String>,
        previous: bool,
        timestamps: bool,
    ) {
        self.stop_log(id);
        let Some(client) = self.require_client(&context) else {
            self.emit(AppEvent::LogClosed { id });
            return;
        };
        let cancel = CancellationToken::new();
        self.logs.insert(
            id,
            LiveStream {
                context,
                cancel: cancel.clone(),
            },
        );
        let events = self.events.clone();
        let label = name.clone();
        let query = LogQuery {
            kind,
            namespace,
            name,
            pod,
            container,
            previous,
            timestamps,
        };
        tokio::spawn(async move {
            if let Err(err) = stream_logs(client, id, query, cancel, events.clone()).await {
                let _ = events.send(AppEvent::Error(format!("logs {label}: {err}")));
                let _ = events.send(AppEvent::LogClosed { id });
            }
        });
    }

    fn spawn_delete(&self, context: String, target: WatchTarget, namespace: String, name: String) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            let result = match &target {
                WatchTarget::Kind(kind) => delete_for(client, *kind, &namespace, &name).await,
                WatchTarget::Custom(target) => {
                    let resource =
                        resource_of(&target.group, &target.version, &target.kind, &target.plural);
                    delete_dynamic(client, &resource, target.namespaced, &namespace, &name).await
                }
            };
            if let Err(err) = result {
                let _ = events.send(AppEvent::Error(format!("delete {name}: {err}")));
            }
        });
    }

    fn spawn_restart(&self, context: String, kind: ResourceKind, namespace: String, name: String) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            if let Err(err) = restart_workload(client, kind, &namespace, &name).await {
                let _ = events.send(AppEvent::Error(format!("restart {name}: {err}")));
            }
        });
    }

    fn spawn_apply(&self, context: String, yaml: String, namespace: Option<String>) {
        let Some(client) = self.client_for(&context) else {
            self.emit(AppEvent::ApplyResult {
                context,
                error: Some("Not connected to a cluster".to_string()),
            });
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            let error = apply_documents(&client, &yaml, namespace.as_deref())
                .await
                .err();
            let _ = events.send(AppEvent::ApplyResult { context, error });
        });
    }

    fn spawn_fetch(
        &self,
        context: String,
        target: WatchTarget,
        namespace: String,
        name: String,
        uid: String,
        reveal_secrets: bool,
    ) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            load_detail(
                client,
                context,
                target,
                namespace,
                name,
                uid,
                reveal_secrets,
                events,
            )
            .await;
        });
    }

    fn spawn_events(&self, context: String, namespace: String, name: String, uid: String) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            match object_events(&client, &namespace, &name, &uid).await {
                Ok(list) => {
                    let _ = events.send(AppEvent::ObjectEvents { context, uid, events: list });
                }
                Err(err) => {
                    let _ = events.send(AppEvent::Error(format!("events {name}: {err}")));
                }
            }
        });
    }

    /// Reads the ConfigMaps and Secrets a pod refers to, so the panel can show
    /// resolved mounts and environment values.
    fn spawn_pod_sources(
        &self,
        context: String,
        namespace: String,
        name: String,
        uid: String,
        reveal: bool,
    ) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            match load_pod_sources(&client, &namespace, &name, reveal).await {
                Ok((mounts, env)) => {
                    let _ = events.send(AppEvent::PodSources {
                        context,
                        uid,
                        mounts,
                        env,
                    });
                }
                Err(err) => {
                    let _ = events.send(AppEvent::Error(format!("sources {name}: {err}")));
                }
            }
        });
    }

    /// Spec and live status of every container of a pod, for the Containers
    /// block of the object panel.
    fn spawn_pod_containers(
        &self,
        context: String,
        namespace: String,
        name: String,
        uid: String,
        reveal: bool,
    ) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            match load_pod_containers(&client, &namespace, &name, reveal).await {
                Ok(containers) => {
                    let _ = events.send(AppEvent::PodContainers {
                        context,
                        uid,
                        containers,
                    });
                }
                Err(err) => {
                    let _ = events.send(AppEvent::Error(format!("containers {name}: {err}")));
                }
            }
        });
    }

    /// Scans warning events once for the whole list, so rows can be marked
    /// before the user opens any of them.
    fn spawn_warnings(&self, context: String, namespace: Option<String>) {
        let Some(client) = self.require_client(&context) else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            let api = match namespace.as_deref() {
                Some(ns) if !ns.is_empty() => Api::<Event>::namespaced(client, ns),
                _ => Api::<Event>::all(client),
            };
            match list_query(api, "", "type=Warning").await {
                Ok(list) => {
                    let _ = events.send(AppEvent::Warnings {
                        context,
                        namespace,
                        objects: aggregate_warnings(&list),
                    });
                }
                Err(err) => {
                    let _ = events.send(AppEvent::Error(format!("warnings {context}: {err}")));
                }
            }
        });
    }

    fn fetch_overview(&self, context: String) {
        let Some(client) = self.client_for(&context) else {
            return;
        };
        let events = self.events.clone();
        let cache = self.argo_cache.clone();
        tokio::spawn(async move {
            match overview(&client, context.clone(), cache).await {
                Ok(snapshot) => {
                    let _ = events.send(AppEvent::Overview {
                        context,
                        overview: Box::new(snapshot),
                    });
                }
                Err(err) => {
                    let _ = events.send(AppEvent::Error(err));
                }
            }
        });
    }
}

fn namespaced<K>(client: Client, namespace: &Option<String>) -> Api<K>
where
    K: Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + DeserializeOwned
        + std::fmt::Debug,
{
    match namespace {
        Some(namespace) => Api::namespaced(client, namespace),
        None => Api::all(client),
    }
}

fn spawn_watch<K>(
    api: Api<K>,
    target: WatchTarget,
    to_row: fn(&K) -> crate::model::ResourceRow,
    cancel: CancellationToken,
    events: std::sync::mpsc::Sender<AppEvent>,
    page_size: Option<u32>,
    context: String,
) where
    K: Resource + Clone + DeserializeOwned + std::fmt::Debug + Send + Sync + 'static,
{
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let reader_cancel = cancel.clone();
        let config = match page_size {
            Some(page_size) => watcher::Config::default().page_size(page_size),
            None => watcher::Config::default(),
        };
        tokio::spawn(async move {
            let mut stream = std::pin::pin!(watcher(api, config));
            loop {
                tokio::select! {
                    _ = reader_cancel.cancelled() => break,
                    item = stream.next() => {
                        match item {
                            None => break,
                            Some(item) => {
                                if tx.send(item).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        });

        let mut rows = Vec::new();
        let mut dirty = false;
        let mut deadline = tokio::time::Instant::now();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep_until(deadline), if dirty => {
                    publish(&events, &context, &target, &rows);
                    dirty = false;
                }
                item = rx.recv() => {
                    let Some(item) = item else { break };
                    match item {
                        Ok(WatchEvent::Init) => rows.clear(),
                        Ok(WatchEvent::InitApply(object)) => rows.push(to_row(&object)),
                        Ok(WatchEvent::InitDone) => {
                            publish(&events, &context, &target, &rows);
                            dirty = false;
                        }
                        Ok(WatchEvent::Apply(object)) => {
                            let row = to_row(&object);
                            if let Some(slot) = rows.iter_mut().find(|existing| existing.uid == row.uid) {
                                *slot = row;
                            } else {
                                rows.push(row);
                            }
                            if !dirty {
                                deadline = tokio::time::Instant::now() + Duration::from_millis(200);
                                dirty = true;
                            }
                        }
                        Ok(WatchEvent::Delete(object)) => {
                            let row = to_row(&object);
                            rows.retain(|existing| existing.uid != row.uid);
                            if !dirty {
                                deadline = tokio::time::Instant::now() + Duration::from_millis(200);
                                dirty = true;
                            }
                        }
                        Err(err) => {
                            let _ = events.send(AppEvent::Error(format!("watch {target}: {err}")));
                        }
                    }
                }
            }
        }
    });
}

fn spawn_metrics<F>(
    context: String,
    kind: ResourceKind,
    cancel: CancellationToken,
    events: std::sync::mpsc::Sender<AppEvent>,
    mut fetch: F,
) where
    F: FnMut() -> Pin<Box<dyn Future<Output = Result<Vec<UsageSample>, String>> + Send>>
        + Send
        + 'static,
{
    tokio::spawn(async move {
        loop {
            if cancel.is_cancelled() {
                break;
            }
            match fetch().await {
                Ok(samples) => {
                    let _ = events.send(AppEvent::Usage {
                        context: context.clone(),
                        kind,
                        samples,
                    });
                }
                Err(err) if metrics_missing(&err) => {
                    let _ = events.send(AppEvent::MetricsUnavailable {
                        context: context.clone(),
                        kind,
                        message: err,
                    });
                    break;
                }
                Err(err) => {
                    let _ = events.send(AppEvent::Error(format!("metrics {context}: {err}")));
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(10)) => {}
            }
        }
    });
}

fn metrics_missing(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("notfound")
        || lower.contains("not found")
        || lower.contains("404")
        || lower.contains("metrics.k8s.io")
        || lower.contains("forbidden")
        || lower.contains("403")
}

fn publish(
    events: &std::sync::mpsc::Sender<AppEvent>,
    context: &str,
    target: &WatchTarget,
    rows: &[crate::model::ResourceRow],
) {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| a.namespace.cmp(&b.namespace).then(a.name.cmp(&b.name)));
    let _ = events.send(AppEvent::Rows {
        context: context.to_string(),
        target: target.clone(),
        rows,
    });
}

macro_rules! delete_ns {
    ($client:expr, $namespace:expr, $name:expr, $ty:ty) => {
        delete_named(ns_api::<$ty>($client, $namespace), $name).await
    };
}

macro_rules! delete_cluster {
    ($client:expr, $name:expr, $ty:ty) => {
        delete_named(Api::<$ty>::all($client), $name).await
    };
}

async fn delete_named<K>(api: Api<K>, name: &str) -> Result<(), String>
where
    K: Clone + DeserializeOwned + std::fmt::Debug,
{
    api.delete(name, &DeleteParams::default())
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

async fn delete_for(
    client: Client,
    kind: ResourceKind,
    namespace: &str,
    name: &str,
) -> Result<(), String> {
    match kind {
        ResourceKind::Pods => delete_ns!(client, namespace, name, Pod),
        ResourceKind::Deployments => delete_ns!(client, namespace, name, Deployment),
        ResourceKind::ReplicaSets => delete_ns!(client, namespace, name, ReplicaSet),
        ResourceKind::StatefulSets => delete_ns!(client, namespace, name, StatefulSet),
        ResourceKind::DaemonSets => delete_ns!(client, namespace, name, DaemonSet),
        ResourceKind::Jobs => delete_ns!(client, namespace, name, Job),
        ResourceKind::CronJobs => delete_ns!(client, namespace, name, CronJob),
        ResourceKind::Services => delete_ns!(client, namespace, name, Service),
        ResourceKind::Endpoints => delete_ns!(client, namespace, name, Endpoints),
        ResourceKind::EndpointSlices => delete_ns!(client, namespace, name, EndpointSlice),
        ResourceKind::Ingresses => delete_ns!(client, namespace, name, Ingress),
        ResourceKind::NetworkPolicies => delete_ns!(client, namespace, name, NetworkPolicy),
        ResourceKind::ConfigMaps => delete_ns!(client, namespace, name, ConfigMap),
        ResourceKind::Secrets => delete_ns!(client, namespace, name, Secret),
        ResourceKind::Events => delete_ns!(client, namespace, name, Event),
        ResourceKind::ResourceQuotas => delete_ns!(client, namespace, name, ResourceQuota),
        ResourceKind::LimitRanges => delete_ns!(client, namespace, name, LimitRange),
        ResourceKind::HorizontalPodAutoscalers => {
            delete_ns!(client, namespace, name, HorizontalPodAutoscaler)
        }
        ResourceKind::PodDisruptionBudgets => {
            delete_ns!(client, namespace, name, PodDisruptionBudget)
        }
        ResourceKind::PersistentVolumeClaims => {
            delete_ns!(client, namespace, name, PersistentVolumeClaim)
        }
        ResourceKind::ServiceAccounts => delete_ns!(client, namespace, name, ServiceAccount),
        ResourceKind::Roles => delete_ns!(client, namespace, name, Role),
        ResourceKind::RoleBindings => delete_ns!(client, namespace, name, RoleBinding),
        ResourceKind::Nodes => delete_cluster!(client, name, Node),
        ResourceKind::Namespaces => delete_cluster!(client, name, Namespace),
        ResourceKind::IngressClasses => delete_cluster!(client, name, IngressClass),
        ResourceKind::PersistentVolumes => delete_cluster!(client, name, PersistentVolume),
        ResourceKind::StorageClasses => delete_cluster!(client, name, StorageClass),
        ResourceKind::ClusterRoles => delete_cluster!(client, name, ClusterRole),
        ResourceKind::ClusterRoleBindings => delete_cluster!(client, name, ClusterRoleBinding),
        ResourceKind::CustomResourceDefinitions => {
            delete_cluster!(client, name, CustomResourceDefinition)
        }
        ResourceKind::GatewayClasses
        | ResourceKind::Gateways
        | ResourceKind::HttpRoutes
        | ResourceKind::GrpcRoutes
        | ResourceKind::TlsRoutes
        | ResourceKind::TcpRoutes
        | ResourceKind::UdpRoutes
        | ResourceKind::BackendTLSPolicies
        | ResourceKind::ListenerSets
        | ResourceKind::ReferenceGrants => {
            let (resource, namespaced) = gateway_api(kind);
            delete_dynamic(client, &resource, namespaced, namespace, name).await
        }
    }
}

async fn delete_dynamic(
    client: Client,
    resource: &ApiResource,
    namespaced: bool,
    namespace: &str,
    name: &str,
) -> Result<(), String> {
    let api = if namespaced && !namespace.is_empty() {
        Api::<DynamicObject>::namespaced_with(client, namespace, resource)
    } else {
        Api::<DynamicObject>::all_with(client, resource)
    };
    delete_named(api, name).await
}

async fn restart_workload(
    client: Client,
    kind: ResourceKind,
    namespace: &str,
    name: &str,
) -> Result<(), String> {
    let (kind, name) = if kind == ResourceKind::Pods {
        pod_controller(&client, namespace, name).await?
    } else {
        (kind, name.to_string())
    };
    let patch = serde_json::json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": rfc3339_now()
                    }
                }
            }
        }
    });
    let params = PatchParams::default();
    let result = match kind {
        ResourceKind::Deployments => ns_api::<Deployment>(client, namespace)
            .patch(&name, &params, &Patch::Merge(patch.clone()))
            .await
            .map(|_| ()),
        ResourceKind::StatefulSets => ns_api::<StatefulSet>(client, namespace)
            .patch(&name, &params, &Patch::Merge(patch.clone()))
            .await
            .map(|_| ()),
        ResourceKind::DaemonSets => ns_api::<DaemonSet>(client, namespace)
            .patch(&name, &params, &Patch::Merge(patch))
            .await
            .map(|_| ()),
        _ => return Err("restart is only supported for workloads with a pod template".into()),
    };
    result.map_err(|err| err.to_string())
}

const NO_CONTROLLER: &str = "pod has no Deployment, StatefulSet, or DaemonSet";

async fn pod_controller(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<(ResourceKind, String), String> {
    let pod = Api::<Pod>::namespaced(client.clone(), namespace)
        .get(name)
        .await
        .map_err(|err| err.to_string())?;
    let owner = controlling(pod.metadata.owner_references.as_deref().unwrap_or(&[]))
        .ok_or(NO_CONTROLLER)?;
    match owner.kind.as_str() {
        "Deployment" => Ok((ResourceKind::Deployments, owner.name.clone())),
        "StatefulSet" => Ok((ResourceKind::StatefulSets, owner.name.clone())),
        "DaemonSet" => Ok((ResourceKind::DaemonSets, owner.name.clone())),
        "ReplicaSet" => {
            let set = Api::<ReplicaSet>::namespaced(client.clone(), namespace)
                .get(&owner.name)
                .await
                .map_err(|err| err.to_string())?;
            let parent = controlling(set.metadata.owner_references.as_deref().unwrap_or(&[]))
                .ok_or(NO_CONTROLLER)?;
            workload_target(Some(owner), Some(parent))
        }
        _ => workload_target(Some(owner), None),
    }
}

fn controlling(
    refs: &[k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference],
) -> Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference> {
    refs.iter()
        .find(|item| item.controller == Some(true))
        .or_else(|| refs.first())
}

fn workload_target(
    pod_owner: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference>,
    replicaset_owner: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference>,
) -> Result<(ResourceKind, String), String> {
    let Some(owner) = pod_owner else {
        return Err(NO_CONTROLLER.to_string());
    };
    match owner.kind.as_str() {
        "Deployment" => Ok((ResourceKind::Deployments, owner.name.clone())),
        "StatefulSet" => Ok((ResourceKind::StatefulSets, owner.name.clone())),
        "DaemonSet" => Ok((ResourceKind::DaemonSets, owner.name.clone())),
        "ReplicaSet" => {
            let Some(parent) = replicaset_owner else {
                return Err(NO_CONTROLLER.to_string());
            };
            if parent.kind == "Deployment" {
                Ok((ResourceKind::Deployments, parent.name.clone()))
            } else {
                Err(NO_CONTROLLER.to_string())
            }
        }
        _ => Err(NO_CONTROLLER.to_string()),
    }
}

struct LogQuery {
    kind: ResourceKind,
    namespace: String,
    name: String,
    pod: Option<String>,
    container: Option<String>,
    previous: bool,
    timestamps: bool,
}

struct LogFollow {
    id: u64,
    namespace: String,
    name: String,
    pods: Vec<String>,
    pod: String,
    container: Option<String>,
    previous: bool,
    timestamps: bool,
}

async fn stream_logs(
    client: Client,
    id: u64,
    query: LogQuery,
    cancel: CancellationToken,
    events: std::sync::mpsc::Sender<AppEvent>,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Ok(());
    }
    let (pods, pod_name) = log_pods(&client, &query).await?;
    if cancel.is_cancelled() {
        return Ok(());
    }
    let Some(pod_name) = pod_name else {
        let _ = events.send(AppEvent::LogStarted {
            id,
            namespace: query.namespace,
            name: query.name,
            pods,
            pod: String::new(),
            containers: Vec::new(),
            container: String::new(),
        });
        return Ok(());
    };
    follow_logs(
        client,
        LogFollow {
            id,
            namespace: query.namespace,
            name: query.name,
            pods,
            pod: pod_name,
            container: query.container,
            previous: query.previous,
            timestamps: query.timestamps,
        },
        cancel,
        events,
    )
    .await
}

async fn log_pods(
    client: &Client,
    query: &LogQuery,
) -> Result<(Vec<String>, Option<String>), String> {
    if query.kind == ResourceKind::Pods {
        return Ok((vec![query.name.clone()], Some(query.name.clone())));
    }
    let Some(selector) =
        workload_selector(client, query.kind, &query.namespace, &query.name).await?
    else {
        return Ok((Vec::new(), None));
    };
    let listed = list_labeled(
        ns_api::<Pod>(client.clone(), &query.namespace),
        &selector_query(&selector),
    )
    .await?;
    let mut pods: Vec<String> = listed
        .into_iter()
        .filter_map(|pod| pod.metadata.name)
        .collect();
    pods.sort();
    let selected = query
        .pod
        .clone()
        .filter(|item| pods.contains(item))
        .or_else(|| pods.first().cloned());
    Ok((pods, selected))
}

async fn workload_selector(
    client: &Client,
    kind: ResourceKind,
    namespace: &str,
    name: &str,
) -> Result<Option<LabelSelector>, String> {
    match kind {
        ResourceKind::Deployments => {
            spec_selector::<Deployment, _>(client, namespace, name, |item| {
                item.spec.map(|spec| spec.selector)
            })
            .await
        }
        ResourceKind::ReplicaSets => {
            spec_selector::<ReplicaSet, _>(client, namespace, name, |item| {
                item.spec.map(|spec| spec.selector)
            })
            .await
        }
        ResourceKind::StatefulSets => {
            spec_selector::<StatefulSet, _>(client, namespace, name, |item| {
                item.spec.map(|spec| spec.selector)
            })
            .await
        }
        ResourceKind::DaemonSets => {
            spec_selector::<DaemonSet, _>(client, namespace, name, |item| {
                item.spec.map(|spec| spec.selector)
            })
            .await
        }
        ResourceKind::Jobs => {
            spec_selector::<Job, _>(client, namespace, name, |item| {
                item.spec.and_then(|spec| spec.selector)
            })
            .await
        }
        _ => Err(format!("{} does not have pod logs", kind.title())),
    }
}

async fn spec_selector<K, F>(
    client: &Client,
    namespace: &str,
    name: &str,
    pick: F,
) -> Result<Option<LabelSelector>, String>
where
    K: Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + DeserializeOwned
        + std::fmt::Debug,
    F: FnOnce(K) -> Option<LabelSelector>,
{
    let item = ns_api::<K>(client.clone(), namespace)
        .get(name)
        .await
        .map_err(|err| err.to_string())?;
    Ok(pick(item))
}

fn selector_query(selector: &LabelSelector) -> String {
    let mut parts = Vec::new();
    if let Some(labels) = &selector.match_labels {
        for (key, value) in labels {
            parts.push(format!("{key}={value}"));
        }
    }
    if let Some(requirements) = &selector.match_expressions {
        for requirement in requirements {
            let values = requirement.values.as_deref().unwrap_or(&[]);
            match requirement.operator.as_str() {
                "In" => parts.push(format!("{} in ({})", requirement.key, values.join(","))),
                "NotIn" => parts.push(format!("{} notin ({})", requirement.key, values.join(","))),
                "Exists" => parts.push(requirement.key.clone()),
                "DoesNotExist" => parts.push(format!("!{}", requirement.key)),
                _ => {}
            }
        }
    }
    parts.join(",")
}

/// Lines kept from the live stream before following.
const LIVE_TAIL_LINES: i64 = 200;
/// A terminated container cannot be followed, so widen the window instead.
const PREVIOUS_TAIL_LINES: i64 = 1000;

async fn follow_logs(
    client: Client,
    follow: LogFollow,
    cancel: CancellationToken,
    events: std::sync::mpsc::Sender<AppEvent>,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Ok(());
    }
    let LogFollow {
        id,
        namespace,
        name,
        pods,
        pod: pod_name,
        container,
        previous,
        timestamps,
    } = follow;
    let api = Api::<Pod>::namespaced(client, &namespace);
    let pod = api.get(&pod_name).await.map_err(|err| err.to_string())?;
    if cancel.is_cancelled() {
        return Ok(());
    }
    let containers = pod_container_names(&pod);
    if containers.is_empty() {
        return Err("pod has no containers".to_string());
    }
    let selected = container
        .filter(|item| containers.iter().any(|name| name == item))
        .unwrap_or_else(|| containers[0].clone());
    let _ = events.send(AppEvent::LogStarted {
        id,
        namespace: namespace.clone(),
        name,
        pods,
        pod: pod_name.clone(),
        containers,
        container: selected.clone(),
    });
    if cancel.is_cancelled() {
        return Ok(());
    }
    let params = LogParams {
        container: Some(selected),
        // A terminated container has nothing to follow: the stream ends at EOF.
        follow: !previous,
        previous,
        timestamps,
        tail_lines: Some(if previous {
            PREVIOUS_TAIL_LINES
        } else {
            LIVE_TAIL_LINES
        }),
        ..LogParams::default()
    };
    let reader = api
        .log_stream(&pod_name, &params)
        .await
        .map_err(|err| err.to_string())?;
    let mut lines = std::pin::pin!(reader.lines());
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            item = lines.next() => {
                match item {
                    None => break,
                    Some(Err(err)) => return Err(err.to_string()),
                    Some(Ok(line)) => {
                        let _ = events.send(AppEvent::LogLine { id, line });
                    }
                }
            }
        }
    }
    let _ = events.send(AppEvent::LogClosed { id });
    Ok(())
}

fn pod_container_names(pod: &Pod) -> Vec<String> {
    let Some(spec) = &pod.spec else {
        return Vec::new();
    };
    let mut names: Vec<String> = spec
        .containers
        .iter()
        .map(|item| item.name.clone())
        .collect();
    if let Some(init) = &spec.init_containers {
        names.extend(init.iter().map(|item| item.name.clone()));
    }
    names
}

fn rfc3339_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as u32;
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

async fn yaml_for(
    client: Client,
    kind: ResourceKind,
    namespace: &str,
    name: &str,
    reveal_secrets: bool,
) -> Result<String, String> {
    match kind {
        ResourceKind::Pods => {
            yaml_ns!(client, namespace, name, Pod, "v1", "Pod")
        }
        ResourceKind::Deployments => {
            yaml_ns!(client, namespace, name, Deployment, "apps/v1", "Deployment")
        }
        ResourceKind::ReplicaSets => {
            yaml_ns!(client, namespace, name, ReplicaSet, "apps/v1", "ReplicaSet")
        }
        ResourceKind::StatefulSets => {
            yaml_ns!(
                client,
                namespace,
                name,
                StatefulSet,
                "apps/v1",
                "StatefulSet"
            )
        }
        ResourceKind::DaemonSets => {
            yaml_ns!(client, namespace, name, DaemonSet, "apps/v1", "DaemonSet")
        }
        ResourceKind::Jobs => yaml_ns!(client, namespace, name, Job, "batch/v1", "Job"),
        ResourceKind::CronJobs => {
            yaml_ns!(client, namespace, name, CronJob, "batch/v1", "CronJob")
        }
        ResourceKind::Services => yaml_ns!(client, namespace, name, Service, "v1", "Service"),
        ResourceKind::Endpoints => {
            yaml_ns!(client, namespace, name, Endpoints, "v1", "Endpoints")
        }
        ResourceKind::EndpointSlices => yaml_ns!(
            client,
            namespace,
            name,
            EndpointSlice,
            "discovery.k8s.io/v1",
            "EndpointSlice"
        ),
        ResourceKind::Ingresses => yaml_ns!(
            client,
            namespace,
            name,
            Ingress,
            "networking.k8s.io/v1",
            "Ingress"
        ),
        ResourceKind::NetworkPolicies => yaml_ns!(
            client,
            namespace,
            name,
            NetworkPolicy,
            "networking.k8s.io/v1",
            "NetworkPolicy"
        ),
        ResourceKind::ConfigMaps => {
            yaml_ns!(client, namespace, name, ConfigMap, "v1", "ConfigMap")
        }
        ResourceKind::Secrets => {
            read_yaml(
                ns_api::<Secret>(client, namespace),
                name,
                "v1",
                "Secret",
                !reveal_secrets,
            )
            .await
        }
        ResourceKind::Events => yaml_ns!(client, namespace, name, Event, "v1", "Event"),
        ResourceKind::ResourceQuotas => {
            yaml_ns!(
                client,
                namespace,
                name,
                ResourceQuota,
                "v1",
                "ResourceQuota"
            )
        }
        ResourceKind::LimitRanges => {
            yaml_ns!(client, namespace, name, LimitRange, "v1", "LimitRange")
        }
        ResourceKind::HorizontalPodAutoscalers => yaml_ns!(
            client,
            namespace,
            name,
            HorizontalPodAutoscaler,
            "autoscaling/v2",
            "HorizontalPodAutoscaler"
        ),
        ResourceKind::PodDisruptionBudgets => yaml_ns!(
            client,
            namespace,
            name,
            PodDisruptionBudget,
            "policy/v1",
            "PodDisruptionBudget"
        ),
        ResourceKind::PersistentVolumeClaims => yaml_ns!(
            client,
            namespace,
            name,
            PersistentVolumeClaim,
            "v1",
            "PersistentVolumeClaim"
        ),
        ResourceKind::ServiceAccounts => {
            yaml_ns!(
                client,
                namespace,
                name,
                ServiceAccount,
                "v1",
                "ServiceAccount"
            )
        }
        ResourceKind::Roles => yaml_ns!(
            client,
            namespace,
            name,
            Role,
            "rbac.authorization.k8s.io/v1",
            "Role"
        ),
        ResourceKind::RoleBindings => yaml_ns!(
            client,
            namespace,
            name,
            RoleBinding,
            "rbac.authorization.k8s.io/v1",
            "RoleBinding"
        ),
        ResourceKind::Nodes => yaml_cluster!(client, name, Node, "v1", "Node"),
        ResourceKind::Namespaces => yaml_cluster!(client, name, Namespace, "v1", "Namespace"),
        ResourceKind::IngressClasses => yaml_cluster!(
            client,
            name,
            IngressClass,
            "networking.k8s.io/v1",
            "IngressClass"
        ),
        ResourceKind::PersistentVolumes => {
            yaml_cluster!(client, name, PersistentVolume, "v1", "PersistentVolume")
        }
        ResourceKind::StorageClasses => yaml_cluster!(
            client,
            name,
            StorageClass,
            "storage.k8s.io/v1",
            "StorageClass"
        ),
        ResourceKind::ClusterRoles => yaml_cluster!(
            client,
            name,
            ClusterRole,
            "rbac.authorization.k8s.io/v1",
            "ClusterRole"
        ),
        ResourceKind::ClusterRoleBindings => yaml_cluster!(
            client,
            name,
            ClusterRoleBinding,
            "rbac.authorization.k8s.io/v1",
            "ClusterRoleBinding"
        ),
        ResourceKind::CustomResourceDefinitions => yaml_cluster!(
            client,
            name,
            CustomResourceDefinition,
            "apiextensions.k8s.io/v1",
            "CustomResourceDefinition"
        ),
        ResourceKind::GatewayClasses
        | ResourceKind::Gateways
        | ResourceKind::HttpRoutes
        | ResourceKind::GrpcRoutes
        | ResourceKind::TlsRoutes
        | ResourceKind::TcpRoutes
        | ResourceKind::UdpRoutes
        | ResourceKind::BackendTLSPolicies
        | ResourceKind::ListenerSets
        | ResourceKind::ReferenceGrants => {
            let (resource, namespaced) = gateway_api(kind);
            yaml_dynamic(client, &resource, namespaced, namespace, name).await
        }
    }
}

fn gateway_api(kind: ResourceKind) -> (ApiResource, bool) {
    let (version, name, plural, namespaced) = match kind {
        ResourceKind::GatewayClasses => ("v1", "GatewayClass", "gatewayclasses", false),
        ResourceKind::Gateways => ("v1", "Gateway", "gateways", true),
        ResourceKind::HttpRoutes => ("v1", "HTTPRoute", "httproutes", true),
        ResourceKind::GrpcRoutes => ("v1", "GRPCRoute", "grpcroutes", true),
        ResourceKind::TlsRoutes => ("v1", "TLSRoute", "tlsroutes", true),
        ResourceKind::TcpRoutes => ("v1", "TCPRoute", "tcproutes", true),
        ResourceKind::UdpRoutes => ("v1", "UDPRoute", "udproutes", true),
        ResourceKind::BackendTLSPolicies => ("v1", "BackendTLSPolicy", "backendtlspolicies", true),
        ResourceKind::ListenerSets => ("v1", "ListenerSet", "listenersets", true),
        ResourceKind::ReferenceGrants => ("v1beta1", "ReferenceGrant", "referencegrants", true),
        _ => unreachable!("not a Gateway API kind"),
    };
    (
        resource_of("gateway.networking.k8s.io", version, name, plural),
        namespaced,
    )
}

fn resource_of(group: &str, version: &str, kind: &str, plural: &str) -> ApiResource {
    ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, kind), plural)
}

fn dynamic_api(
    client: Client,
    resource: &ApiResource,
    namespaced: bool,
    namespace: &Option<String>,
) -> Api<DynamicObject> {
    if namespaced {
        match namespace {
            Some(namespace) => Api::namespaced_with(client, namespace, resource),
            None => Api::all_with(client, resource),
        }
    } else {
        Api::all_with(client, resource)
    }
}

async fn yaml_dynamic(
    client: Client,
    resource: &ApiResource,
    namespaced: bool,
    namespace: &str,
    name: &str,
) -> Result<String, String> {
    let api = if namespaced && !namespace.is_empty() {
        Api::<DynamicObject>::namespaced_with(client, namespace, resource)
    } else {
        Api::<DynamicObject>::all_with(client, resource)
    };
    read_yaml(api, name, &resource.api_version, &resource.kind, false).await
}

const BUILTIN_GROUPS: &[&str] = &[
    "",
    "apps",
    "batch",
    "autoscaling",
    "policy",
    "networking.k8s.io",
    "storage.k8s.io",
    "rbac.authorization.k8s.io",
    "apiextensions.k8s.io",
    "events.k8s.io",
    "coordination.k8s.io",
    "certificates.k8s.io",
    "node.k8s.io",
    "discovery.k8s.io",
    "flowcontrol.apiserver.k8s.io",
    "scheduling.k8s.io",
    "admissionregistration.k8s.io",
    "apiregistration.k8s.io",
    "metrics.k8s.io",
    "custom.metrics.k8s.io",
    "external.metrics.k8s.io",
];

fn spawn_catalog(
    client: Client,
    context: String,
    cancel: CancellationToken,
    events: std::sync::mpsc::Sender<AppEvent>,
) {
    tokio::spawn(async move {
        if cancel.is_cancelled() {
            return;
        }
        match discover_targets(client).await {
            Ok(targets) if !cancel.is_cancelled() => publish_catalog(&events, &context, &targets),
            Ok(_) => {}
            Err(err) => {
                let _ = events.send(AppEvent::Error(format!("discover APIs: {err}")));
            }
        }
    });
}

async fn discover_targets(client: Client) -> Result<Vec<CrTarget>, String> {
    let discovery = match Discovery::new(client.clone())
        .exclude(BUILTIN_GROUPS)
        .run_aggregated()
        .await
    {
        Ok(discovery) => discovery,
        Err(_) => Discovery::new(client)
            .exclude(BUILTIN_GROUPS)
            .run()
            .await
            .map_err(|err| err.to_string())?,
    };
    let mut targets = Vec::new();
    for group in discovery.groups() {
        for (resource, caps) in group.resources_by_stability() {
            if resource.plural.contains('/')
                || resource.kind.is_empty()
                || !caps.supports_operation(kube::discovery::verbs::LIST)
            {
                continue;
            }
            let name = if resource.group.is_empty() {
                resource.plural.clone()
            } else {
                format!("{}.{}", resource.plural, resource.group)
            };
            targets.push(CrTarget {
                name,
                kind: resource.kind,
                group: resource.group,
                version: resource.version,
                plural: resource.plural,
                namespaced: caps.scope == Scope::Namespaced,
            });
        }
    }
    Ok(targets)
}

fn publish_catalog(
    events: &std::sync::mpsc::Sender<AppEvent>,
    context: &str,
    targets: &[CrTarget],
) {
    let mut targets = targets.to_vec();
    targets.sort_by(|a, b| a.group.cmp(&b.group).then(a.kind.cmp(&b.kind)));
    let _ = events.send(AppEvent::CustomResources {
        context: context.to_string(),
        targets,
    });
}

fn ns_api<K>(client: Client, namespace: &str) -> Api<K>
where
    K: Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + DeserializeOwned
        + std::fmt::Debug,
{
    if namespace.is_empty() {
        Api::all(client)
    } else {
        Api::namespaced(client, namespace)
    }
}

async fn read_yaml<K>(
    api: Api<K>,
    name: &str,
    api_version: &str,
    kind: &str,
    mask_secret: bool,
) -> Result<String, String>
where
    K: Resource + Clone + DeserializeOwned + Serialize + std::fmt::Debug + Send + Sync,
{
    let object = api.get(name).await.map_err(|err| err.to_string())?;
    let value = serde_json::to_value(&object).map_err(|err| err.to_string())?;
    yaml::object_to_yaml(value, api_version, kind, mask_secret)
}

async fn build_client(path: Option<&Path>, context: &str) -> Result<Client, String> {
    let options = KubeConfigOptions {
        context: Some(context.to_string()),
        ..Default::default()
    };
    let config = match path {
        Some(path) => {
            let kubeconfig = Kubeconfig::read_from(path).map_err(|err| err.to_string())?;
            kube::Config::from_custom_kubeconfig(kubeconfig, &options)
                .await
                .map_err(|err| err.to_string())?
        }
        None => kube::Config::from_kubeconfig(&options)
            .await
            .map_err(|err| err.to_string())?,
    };
    Client::try_from(config).map_err(|err| err.to_string())
}

async fn list_namespaces(client: &Client) -> Result<Vec<String>, String> {
    let mut names: Vec<_> = list_all(Api::<Namespace>::all(client.clone()))
        .await?
        .into_iter()
        .filter_map(|namespace| namespace.metadata.name)
        .collect();
    names.sort();
    Ok(names)
}

async fn list_dynamic(api: Api<DynamicObject>) -> Result<Vec<DynamicObject>, String> {
    let mut params = ListParams::default().limit(500);
    let mut items = Vec::new();
    for _ in 0..200 {
        let page = api.list(&params).await.map_err(|err| err.to_string())?;
        items.extend(page.items);
        let Some(token) = page.metadata.continue_.filter(|token| !token.is_empty()) else {
            break;
        };
        params = ListParams::default().limit(500).continue_token(&token);
    }
    Ok(items)
}

async fn list_all<K>(api: Api<K>) -> Result<Vec<K>, String>
where
    K: Resource<DynamicType = ()> + Clone + DeserializeOwned + std::fmt::Debug,
{
    list_labeled(api, "").await
}

async fn list_labeled<K>(api: Api<K>, labels: &str) -> Result<Vec<K>, String>
where
    K: Resource<DynamicType = ()> + Clone + DeserializeOwned + std::fmt::Debug,
{
    list_query(api, labels, "").await
}

async fn list_warnings(client: &Client) -> Result<Vec<Event>, String> {
    list_query(Api::<Event>::all(client.clone()), "", "type=Warning").await
}

/// How many events the detail panel keeps for one object.
const EVENT_LIMIT: usize = 60;

/// Events the cluster attached to one object, warnings first and newest first
/// inside a kind. The UID is the precise link; objects without one fall back to
/// the name selector.
async fn object_events(
    client: &Client,
    namespace: &str,
    name: &str,
    uid: &str,
) -> Result<Vec<EventInfo>, String> {
    let api = if namespace.is_empty() {
        Api::<Event>::all(client.clone())
    } else {
        Api::<Event>::namespaced(client.clone(), namespace)
    };
    let by_name = format!("involvedObject.name={name}");
    let mut listed = if uid.is_empty() {
        list_query(api.clone(), "", &by_name).await?
    } else {
        let by_uid = format!("involvedObject.uid={uid}");
        let found = list_query(api.clone(), "", &by_uid).await?;
        if found.is_empty() {
            list_query(api, "", &by_name).await?
        } else {
            found
        }
    };
    listed.sort_by_key(|event| event_time_age(event));
    let mut events: Vec<EventInfo> = listed.iter().map(to_event_info).collect();
    sort_events(&mut events);
    events.truncate(EVENT_LIMIT);
    Ok(events)
}

fn to_event_info(event: &Event) -> EventInfo {
    EventInfo {
        kind: event
            .type_
            .clone()
            .unwrap_or_else(|| "Normal".to_string()),
        reason: event.reason.clone().unwrap_or_default(),
        message: event.message.clone().unwrap_or_default(),
        count: event
            .count
            .or_else(|| event.series.as_ref().and_then(|series| series.count))
            .unwrap_or(1)
            .max(1),
        age_secs: event_time_age(event),
        source: event
            .source
            .as_ref()
            .and_then(|source| source.component.clone())
            .or_else(|| event.reporting_component.clone())
            .unwrap_or_default(),
    }
}

/// Warnings first, then the most recent, then the loudest. Events without a
/// timestamp sink to the bottom of their kind.
fn sort_events(events: &mut [EventInfo]) {
    events.sort_by(|a, b| {
        (a.kind != "Warning")
            .cmp(&(b.kind != "Warning"))
            .then_with(|| {
                a.age_secs
                    .unwrap_or(u64::MAX)
                    .cmp(&b.age_secs.unwrap_or(u64::MAX))
            })
            .then_with(|| b.count.cmp(&a.count))
    });
}

/// A failing readiness/liveness/startup probe. Probe noise matters only while
/// the pod is still coming up, so it is tracked apart from real trouble.
fn is_probe_warning(event: &Event) -> bool {
    let reason = event.reason.as_deref().unwrap_or("");
    let message = event.message.as_deref().unwrap_or("").to_ascii_lowercase();
    if reason.eq_ignore_ascii_case("Unhealthy") || reason.eq_ignore_ascii_case("ProbeWarning") {
        return true;
    }
    message.contains("probe")
        && (message.contains("failed") || message.contains("errored") || message.contains("timed out"))
}

/// How many objects with warnings the list scan reports.
const WARNING_OBJECT_LIMIT: usize = 200;

/// Collapses warning events into one entry per involved object. Counts add up
/// and the newest warning supplies the reason.
fn aggregate_warnings(events: &[Event]) -> Vec<ObjectWarning> {
    let mut map: BTreeMap<String, ObjectWarning> = BTreeMap::new();
    for event in events {
        let uid = event.involved_object.uid.clone().unwrap_or_default();
        if uid.is_empty() {
            continue;
        }
        let count = event
            .count
            .or_else(|| event.series.as_ref().and_then(|series| series.count))
            .unwrap_or(1)
            .max(1) as u32;
        let age = event_time_age(event);
        let entry = map.entry(uid.clone()).or_insert_with(|| ObjectWarning {
            uid,
            name: event.involved_object.name.clone().unwrap_or_default(),
            namespace: event.involved_object.namespace.clone().unwrap_or_default(),
            reason: String::new(),
            count: 0,
            age_secs: None,
            probe_only: true,
        });
        entry.count = entry.count.saturating_add(count);
        entry.probe_only = entry.probe_only && is_probe_warning(event);
        let newer = match (entry.age_secs, age) {
            (None, Some(_)) => true,
            (Some(current), Some(age)) => age < current,
            (None, None) => entry.reason.is_empty(),
            (Some(_), None) => false,
        };
        if newer {
            entry.age_secs = age;
            entry.reason = event
                .reason
                .clone()
                .unwrap_or_else(|| "Warning".to_string());
        }
    }
    let mut list: Vec<ObjectWarning> = map.into_values().collect();
    // Loudest first, then the most recent.
    list.sort_by(|a, b| {
        b.count.cmp(&a.count).then_with(|| {
            a.age_secs
                .unwrap_or(u64::MAX)
                .cmp(&b.age_secs.unwrap_or(u64::MAX))
        })
    });
    list.truncate(WARNING_OBJECT_LIMIT);
    list
}

fn event_time_age(event: &Event) -> Option<u64> {
    event
        .last_timestamp
        .as_ref()
        .map(|ts| ts.0.as_second())
        .or_else(|| event.event_time.as_ref().map(|ts| ts.0.as_second()))
        .or_else(|| {
            event
                .metadata
                .creation_timestamp
                .as_ref()
                .map(|ts| ts.0.as_second())
        })
        .map(seconds_since)
}

async fn list_query<K>(api: Api<K>, labels: &str, fields: &str) -> Result<Vec<K>, String>
where
    K: Resource<DynamicType = ()> + Clone + DeserializeOwned + std::fmt::Debug,
{
    let mut params = ListParams::default().limit(500);
    if !labels.is_empty() {
        params = params.labels(labels);
    }
    if !fields.is_empty() {
        params = params.fields(fields);
    }
    let mut items = Vec::new();
    for _ in 0..200 {
        let page: ObjectList<K> = api.list(&params).await.map_err(|err| err.to_string())?;
        items.extend(page.items);
        let Some(token) = page.metadata.continue_.filter(|token| !token.is_empty()) else {
            break;
        };
        params = ListParams::default().limit(500).continue_token(&token);
        if !labels.is_empty() {
            params = params.labels(labels);
        }
        if !fields.is_empty() {
            params = params.fields(fields);
        }
    }
    Ok(items)
}

async fn overview(
    client: &Client,
    context: String,
    cache: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, ArgoTargets>>>,
) -> Result<ClusterOverview, String> {
    let (nodes, pods, namespaces, events, usage) = tokio::join!(
        list_all(Api::<Node>::all(client.clone())),
        list_all(Api::<Pod>::all(client.clone())),
        list_namespaces(client),
        list_warnings(client),
        node_usage_totals(client),
    );
    let nodes = nodes?;
    let pods = pods?;
    let namespaces = namespaces.unwrap_or_default();
    let nodes_total = nodes.len() as u32;
    let nodes_ready = nodes.iter().filter(|node| node_is_ready(node)).count() as u32;
    let phases = pod_phases(&pods);
    let (cpu_alloc, mem_alloc) = node_capacity(&nodes);
    let (cpu_millis, mem_bytes) = usage;
    let (warning_events, warnings, note) = match events {
        Ok(events) => {
            let warnings = recent_warnings(&events);
            let count = warnings_count(&events);
            (Some(count), warnings, None)
        }
        Err(err) => (None, Vec::new(), Some(format!("Events unavailable: {err}"))),
    };
    let argo = argo_overview(client, &context, cache.as_ref()).await;
    Ok(ClusterOverview {
        context,
        nodes_ready,
        nodes_total,
        pods: pods.len() as u32,
        pods_running: phases.0,
        pods_pending: phases.1,
        pods_failed: phases.2,
        pods_succeeded: phases.3,
        pods_unknown: phases.4,
        namespaces: namespaces.len() as u32,
        warning_events,
        warnings,
        cpu_millis,
        cpu_allocatable_millis: cpu_millis.and(cpu_alloc),
        mem_bytes,
        mem_allocatable_bytes: mem_bytes.and(mem_alloc),
        note,
        argo,
    })
}

fn pod_phases(pods: &[Pod]) -> (u32, u32, u32, u32, u32) {
    let mut running = 0;
    let mut pending = 0;
    let mut failed = 0;
    let mut succeeded = 0;
    let mut unknown = 0;
    for pod in pods {
        match pod
            .status
            .as_ref()
            .and_then(|status| status.phase.as_deref())
        {
            Some("Running") => running += 1,
            Some("Pending") => pending += 1,
            Some("Failed") => failed += 1,
            Some("Succeeded") => succeeded += 1,
            _ => unknown += 1,
        }
    }
    (running, pending, failed, succeeded, unknown)
}

fn node_capacity(nodes: &[Node]) -> (Option<f64>, Option<f64>) {
    let mut cpu = 0.0;
    let mut mem = 0.0;
    let mut any_cpu = false;
    let mut any_mem = false;
    for node in nodes {
        let Some(allocatable) = node
            .status
            .as_ref()
            .and_then(|status| status.allocatable.as_ref())
        else {
            continue;
        };
        if let Some(value) = allocatable
            .get("cpu")
            .and_then(|qty| parse_cpu_millis(&qty.0))
        {
            cpu += value;
            any_cpu = true;
        }
        if let Some(value) = allocatable
            .get("memory")
            .and_then(|qty| parse_bytes(&qty.0))
        {
            mem += value;
            any_mem = true;
        }
    }
    (any_cpu.then_some(cpu), any_mem.then_some(mem))
}

async fn node_usage_totals(client: &Client) -> (Option<f64>, Option<f64>) {
    let Ok(metrics) = list_all(Api::<NodeMetrics>::all(client.clone())).await else {
        return (None, None);
    };
    if metrics.is_empty() {
        return (None, None);
    }
    let mut cpu = 0.0;
    let mut mem = 0.0;
    for sample in metrics.iter().filter_map(node_usage) {
        cpu += sample.cpu_millis;
        mem += sample.mem_bytes;
    }
    (Some(cpu), Some(mem))
}

fn warnings_count(events: &[Event]) -> u32 {
    events
        .iter()
        .filter(|event| event.type_.as_deref() == Some("Warning"))
        .count() as u32
}

fn recent_warnings(events: &[Event]) -> Vec<OverviewWarning> {
    let mut warnings: Vec<OverviewWarning> = events
        .iter()
        .filter(|event| event.type_.as_deref() == Some("Warning"))
        .map(|event| {
            let kind = event.involved_object.kind.as_deref().unwrap_or("Object");
            let name = event
                .involved_object
                .name
                .clone()
                .unwrap_or_else(|| "-".to_string());
            let age_secs = event
                .last_timestamp
                .as_ref()
                .or(event.metadata.creation_timestamp.as_ref())
                .map(event_age)
                .unwrap_or(u64::MAX);
            OverviewWarning {
                object: format!("{kind}/{name}"),
                reason: event
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Warning".to_string()),
                message: truncate_chars(event.message.as_deref().unwrap_or(""), 160),
                age_secs,
            }
        })
        .collect();
    warnings.sort_by_key(|warning| warning.age_secs);
    warnings.truncate(8);
    warnings
}

fn event_age(ts: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Time) -> u64 {
    seconds_since(ts.0.as_second())
}

fn seconds_since(then: i64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    now.saturating_sub(then).max(0) as u64
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        text.to_string()
    } else {
        let trimmed: String = text.chars().take(max_chars).collect();
        format!("{trimmed}…")
    }
}

async fn argo_overview(
    client: &Client,
    context: &str,
    cache: &std::sync::Mutex<std::collections::HashMap<String, ArgoTargets>>,
) -> Option<ArgoOverview> {
    let cached = cache
        .lock()
        .ok()
        .and_then(|guard| guard.get(context).cloned());
    let targets = if let Some(targets) = cached {
        targets
    } else {
        let discovery = Discovery::new(client.clone())
            .filter(&["argoproj.io"])
            .run()
            .await
            .ok()?;
        let targets = ArgoTargets {
            app: find_argo_kind(&discovery, "Application"),
            set: find_argo_kind(&discovery, "ApplicationSet"),
        };
        if let Ok(mut guard) = cache.lock() {
            guard.insert(context.to_string(), targets.clone());
        }
        targets
    };
    let target = targets.app?;
    let sets_target = targets.set;
    let (apps_part, sets_part, repos_part, clusters_part) = tokio::join!(
        listed_apps(client, &target),
        listed_sets(client, sets_target.clone()),
        argo_secrets(client, "repository"),
        argo_secrets(client, "cluster"),
    );
    let (apps, note) = apps_part;
    let (app_sets, sets_note) = sets_part;
    let (repos, repos_note) = match repos_part {
        Ok(items) => {
            let mut repos: Vec<ArgoRepo> = items.iter().map(argo_repo).collect();
            repos.sort_by(|a, b| a.name.cmp(&b.name));
            (repos, None)
        }
        Err(err) => (Vec::new(), Some(err)),
    };
    let (clusters, clusters_note) = match clusters_part {
        Ok(items) => {
            let mut clusters: Vec<ArgoCluster> = items.iter().map(argo_cluster).collect();
            clusters.sort_by(|a, b| a.name.cmp(&b.name));
            (clusters, None)
        }
        Err(err) => (Vec::new(), Some(err)),
    };
    Some(ArgoOverview {
        target,
        apps,
        app_sets,
        sets_target,
        repos,
        clusters,
        note,
        sets_note,
        repos_note,
        clusters_note,
    })
}

fn find_argo_kind(discovery: &Discovery, kind: &str) -> Option<CrTarget> {
    let mut found = None;
    for group in discovery.groups() {
        for (resource, caps) in group.resources_by_stability() {
            if resource.kind != kind || !caps.supports_operation(kube::discovery::verbs::LIST) {
                continue;
            }
            let target = CrTarget {
                name: format!("{}.{}", resource.plural, resource.group),
                kind: resource.kind.clone(),
                group: resource.group.clone(),
                version: resource.version.clone(),
                plural: resource.plural.clone(),
                namespaced: caps.scope == Scope::Namespaced,
            };
            let preferred = target.version == "v1alpha1";
            found = Some(target);
            if preferred {
                return found;
            }
        }
    }
    found
}

async fn listed_sets(
    client: &Client,
    target: Option<CrTarget>,
) -> (Vec<ArgoAppSet>, Option<String>) {
    let Some(target) = target else {
        return (
            Vec::new(),
            Some("ApplicationSet is not installed".to_string()),
        );
    };
    listed_app_sets(client, &target).await
}

async fn listed_apps(client: &Client, target: &CrTarget) -> (Vec<ArgoApp>, Option<String>) {
    let resource = resource_of(&target.group, &target.version, &target.kind, &target.plural);
    let api = Api::<DynamicObject>::all_with(client.clone(), &resource);
    match list_dynamic(api).await {
        Ok(items) => {
            let mut apps: Vec<ArgoApp> = items.iter().filter_map(argo_app).collect();
            apps.sort_by(|a, b| a.name.cmp(&b.name).then(a.namespace.cmp(&b.namespace)));
            (apps, None)
        }
        Err(err) => (Vec::new(), Some(err)),
    }
}

async fn listed_app_sets(client: &Client, target: &CrTarget) -> (Vec<ArgoAppSet>, Option<String>) {
    let resource = resource_of(&target.group, &target.version, &target.kind, &target.plural);
    let api = Api::<DynamicObject>::all_with(client.clone(), &resource);
    match list_dynamic(api).await {
        Ok(items) => {
            let mut sets: Vec<ArgoAppSet> = items.iter().filter_map(argo_app_set).collect();
            sets.sort_by(|a, b| a.name.cmp(&b.name).then(a.namespace.cmp(&b.namespace)));
            (sets, None)
        }
        Err(err) => (Vec::new(), Some(err)),
    }
}

async fn argo_secrets(client: &Client, secret_type: &str) -> Result<Vec<Secret>, String> {
    let selector = format!("argocd.argoproj.io/secret-type={secret_type}");
    list_labeled(Api::<Secret>::all(client.clone()), &selector).await
}

fn argo_app(object: &DynamicObject) -> Option<ArgoApp> {
    let name = object.metadata.name.clone()?;
    let namespace = object.metadata.namespace.clone().unwrap_or_default();
    let project = object
        .data
        .get("spec")
        .and_then(|spec| spec.get("project"))
        .and_then(|value| value.as_str())
        .unwrap_or("-")
        .to_string();
    let health = json_status(&object.data, "health").unwrap_or_else(|| "Unknown".to_string());
    let sync = json_status(&object.data, "sync").unwrap_or_else(|| "Unknown".to_string());
    Some(ArgoApp {
        name,
        namespace,
        project,
        health,
        sync,
    })
}

fn argo_app_set(object: &DynamicObject) -> Option<ArgoAppSet> {
    let name = object.metadata.name.clone()?;
    let namespace = object.metadata.namespace.clone().unwrap_or_default();
    let applications = object
        .data
        .get("status")
        .and_then(|status| {
            status
                .get("applicationStatus")
                .or_else(|| status.get("resources"))
        })
        .and_then(|value| value.as_array())
        .map(|items| items.len() as u32)
        .unwrap_or(0);
    Some(ArgoAppSet {
        name,
        namespace,
        applications,
        status: app_set_status(&object.data),
    })
}

fn app_set_status(data: &serde_json::Value) -> String {
    let Some(conditions) = data
        .get("status")
        .and_then(|status| status.get("conditions"))
        .and_then(|value| value.as_array())
    else {
        return "Unknown".to_string();
    };
    for condition in conditions {
        let kind = condition
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let state = condition
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if kind == "ErrorOccurred" && state == "True" {
            let message = condition
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("Error");
            return shorten(message, 160);
        }
    }
    if conditions.iter().any(|condition| {
        condition.get("type").and_then(|value| value.as_str()) == Some("ResourcesUpToDate")
            && condition.get("status").and_then(|value| value.as_str()) == Some("True")
    }) {
        return "Healthy".to_string();
    }
    "Unknown".to_string()
}

fn argo_repo(secret: &Secret) -> ArgoRepo {
    let fallback = secret.metadata.name.clone().unwrap_or_default();
    let name = secret_field(secret, "name");
    ArgoRepo {
        name: if name.is_empty() { fallback } else { name },
        url: secret_field(secret, "url"),
        repo_type: {
            let kind = secret_field(secret, "type");
            if kind.is_empty() {
                "git".to_string()
            } else {
                kind
            }
        },
        project: {
            let project = secret_field(secret, "project");
            if project.is_empty() {
                "-".to_string()
            } else {
                project
            }
        },
    }
}

fn argo_cluster(secret: &Secret) -> ArgoCluster {
    let fallback = secret.metadata.name.clone().unwrap_or_default();
    let name = secret_field(secret, "name");
    ArgoCluster {
        name: if name.is_empty() { fallback } else { name },
        server: secret_field(secret, "server"),
    }
}

fn secret_field(secret: &Secret, key: &str) -> String {
    secret
        .data
        .as_ref()
        .and_then(|data| data.get(key))
        .and_then(|bytes| std::str::from_utf8(&bytes.0).ok())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn shorten(text: &str, limit: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(limit) {
        None => text.to_string(),
        Some((end, _)) => format!("{}…", &text[..end]),
    }
}

fn json_status(data: &serde_json::Value, field: &str) -> Option<String> {
    data.get("status")?
        .get(field)?
        .get("status")?
        .as_str()
        .map(str::to_string)
}

fn configmap_entries(item: &ConfigMap) -> Vec<DataEntry> {
    let mut entries = Vec::new();
    if let Some(data) = &item.data {
        for (key, value) in data {
            entries.push(DataEntry {
                key: key.clone(),
                value: value.clone(),
                masked: false,
                binary: false,
            });
        }
    }
    if let Some(data) = &item.binary_data {
        for (key, bytes) in data {
            entries.push(DataEntry {
                key: key.clone(),
                value: format!("binary, {} bytes", bytes.0.len()),
                masked: false,
                binary: true,
            });
        }
    }
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    entries
}

fn secret_entries(item: &Secret, reveal: bool) -> Vec<DataEntry> {
    let mut entries = Vec::new();
    if let Some(data) = &item.data {
        for (key, bytes) in data {
            let (value, binary) = secret_text(&bytes.0);
            entries.push(DataEntry {
                key: key.clone(),
                value,
                masked: !reveal,
                binary,
            });
        }
    }
    if let Some(data) = &item.string_data {
        for (key, value) in data {
            entries.push(DataEntry {
                key: key.clone(),
                value: value.clone(),
                masked: !reveal,
                binary: false,
            });
        }
    }
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    entries
}

/// What backs a volume, for the label and for resolving its keys.
enum Backing<'a> {
    ConfigMap(&'a str),
    Secret(&'a str),
}

fn volume_backing(volume: &Volume) -> Vec<Backing<'_>> {
    let mut backings = Vec::new();
    if let Some(map) = &volume.config_map {
        backings.push(Backing::ConfigMap(&map.name));
    }
    if let Some(secret) = &volume.secret {
        if let Some(name) = &secret.secret_name {
            backings.push(Backing::Secret(name));
        }
    }
    if let Some(projected) = &volume.projected {
        for source in projected.sources.iter().flatten() {
            if let Some(map) = &source.config_map {
                backings.push(Backing::ConfigMap(&map.name));
            }
            if let Some(secret) = &source.secret {
                backings.push(Backing::Secret(&secret.name));
            }
        }
    }
    backings
}

fn volume_label(volume: &Volume) -> String {
    if let Some(map) = &volume.config_map {
        return format!("configMap {}", map.name);
    }
    if let Some(secret) = &volume.secret {
        return format!("secret {}", secret.secret_name.clone().unwrap_or_default());
    }
    if let Some(claim) = &volume.persistent_volume_claim {
        return format!("persistentVolumeClaim {}", claim.claim_name);
    }
    if volume.empty_dir.is_some() {
        return "emptyDir".to_string();
    }
    if volume.host_path.is_some() {
        return "hostPath".to_string();
    }
    if volume.projected.is_some() {
        return "projected".to_string();
    }
    if volume.downward_api.is_some() {
        return "downwardAPI".to_string();
    }
    if volume.nfs.is_some() {
        return "nfs".to_string();
    }
    if volume.csi.is_some() {
        return "csi".to_string();
    }
    if volume.config_map.is_none() && volume.secret.is_none() {
        return "volume".to_string();
    }
    "volume".to_string()
}

/// The volume keys this pod actually sees, honouring `items` when present.
fn mount_values(
    volume: &Volume,
    config_maps: &BTreeMap<String, ConfigMap>,
    secrets: &BTreeMap<String, Secret>,
    reveal: bool,
) -> (Vec<PodValue>, Option<String>) {
    let mut values = Vec::new();
    let mut notes = Vec::new();
    match &volume.config_map {
        Some(map) => {
            let keys = item_keys(map.items.as_deref());
            collect_config_map(config_maps.get(&map.name), &map.name, keys.as_deref(), &mut values, &mut notes);
        }
        None => {}
    }
    if let Some(secret) = &volume.secret {
        let name = secret.secret_name.clone().unwrap_or_default();
        let keys = item_keys(secret.items.as_deref());
        collect_secret(secrets.get(&name), &name, keys.as_deref(), reveal, &mut values, &mut notes);
    }
    if let Some(projected) = &volume.projected {
        for source in projected.sources.iter().flatten() {
            if let Some(map) = &source.config_map {
                let keys = item_keys(map.items.as_deref());
                collect_config_map(config_maps.get(&map.name), &map.name, keys.as_deref(), &mut values, &mut notes);
            }
            if let Some(secret) = &source.secret {
                let name = secret.name.clone();
                let keys = item_keys(secret.items.as_deref());
                collect_secret(secrets.get(&name), &name, keys.as_deref(), reveal, &mut values, &mut notes);
            }
        }
    }
    let note = if notes.is_empty() { None } else { Some(notes.join("; ")) };
    (values, note)
}

fn item_keys(items: Option<&[KeyToPath]>) -> Option<Vec<String>> {
    items.map(|list| list.iter().map(|item| item.key.clone()).collect())
}

fn collect_config_map(
    map: Option<&ConfigMap>,
    name: &str,
    keys: Option<&[String]>,
    values: &mut Vec<PodValue>,
    notes: &mut Vec<String>,
) {
    let Some(map) = map else {
        notes.push(format!("ConfigMap {name} not found or not readable"));
        return;
    };
    for (key, value) in config_entries(map) {
        if keys.is_some_and(|wanted| !wanted.contains(&key)) {
            continue;
        }
        values.push(PodValue {
            key,
            value,
            masked: false,
            binary: false,
        });
    }
}

fn collect_secret(
    secret: Option<&Secret>,
    name: &str,
    keys: Option<&[String]>,
    reveal: bool,
    values: &mut Vec<PodValue>,
    notes: &mut Vec<String>,
) {
    let Some(secret) = secret else {
        notes.push(format!("Secret {name} not found or not readable"));
        return;
    };
    for (key, (value, binary)) in secret_pairs(secret) {
        if keys.is_some_and(|wanted| !wanted.contains(&key)) {
            continue;
        }
        values.push(PodValue {
            key,
            value,
            masked: !reveal,
            binary,
        });
    }
}

fn config_entries(map: &ConfigMap) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = map
        .data
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    if let Some(binary) = &map.binary_data {
        for (key, bytes) in binary {
            entries.push((key.clone(), base64_encode(&bytes.0)));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

/// Every key of a Secret with its real value and whether it is binary. The
/// caller marks secret keys with `masked`, so the UI decides what to hide and
/// one value can be revealed without fetching the Secret again.
fn secret_pairs(secret: &Secret) -> Vec<(String, (String, bool))> {
    let mut entries: Vec<(String, (String, bool))> = secret
        .data
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|(key, bytes)| {
            let (text, binary) = secret_text(&bytes.0);
            (key, (text, binary))
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

fn env_container_names(pod: &Pod) -> Vec<(String, Container)> {
    let Some(spec) = &pod.spec else {
        return Vec::new();
    };
    let mut containers: Vec<(String, Container)> = spec
        .containers
        .iter()
        .map(|item| (item.name.clone(), item.clone()))
        .collect();
    if let Some(init) = &spec.init_containers {
        for item in init {
            containers.push((item.name.clone(), item.clone()));
        }
    }
    containers
}

/// Resolves the pod's own fields that `fieldRef` can point at.
fn field_value(pod: &Pod, path: &str) -> Option<String> {
    let meta = &pod.metadata;
    let status = pod.status.as_ref();
    let spec = pod.spec.as_ref();
    Some(match path {
        "metadata.name" => meta.name.clone()?,
        "metadata.namespace" => meta.namespace.clone()?,
        "metadata.uid" => meta.uid.clone()?,
        "metadata.labels" => {
            let labels = meta.labels.clone().unwrap_or_default();
            labels
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join(",")
        }
        "spec.nodeName" => spec.and_then(|spec| spec.node_name.clone())?,
        "spec.serviceAccountName" => spec.and_then(|spec| spec.service_account_name.clone())?,
        "status.podIP" => status.and_then(|status| status.pod_ip.clone())?,
        "status.hostIP" => status.and_then(|status| status.host_ip.clone())?,
        _ => return None,
    })
}

/// A `resourceFieldRef`: the container's own request or limit for that resource.
fn resource_value(container: &Container, resource: &str) -> Option<String> {
    let resources = container.resources.as_ref();
    let (scope, name) = match resource.split_once('.') {
        Some((scope, name)) => (scope, name),
        None => ("limits", resource),
    };
    let quantities = match scope {
        "limits" => resources.and_then(|item| item.limits.as_ref()),
        _ => resources.and_then(|item| item.requests.as_ref()),
    };
    let quantity = quantities.and_then(|map| map.get(name))?;
    Some(quantity.0.clone())
}

/// Volumes, mounts and environment of a pod, with ConfigMap and Secret values
/// resolved. Secret values carry `masked` while `reveal` is off, so the UI can
/// hide them and still reveal one value at a time. Pure, so the whole mapping is
/// testable without a cluster.
fn pod_sources(
    pod: &Pod,
    config_maps: &BTreeMap<String, ConfigMap>,
    secrets: &BTreeMap<String, Secret>,
    reveal: bool,
) -> (Vec<PodMount>, Vec<PodEnv>) {
    let volumes: BTreeMap<String, Volume> = pod
        .spec
        .as_ref()
        .and_then(|spec| spec.volumes.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|volume| (volume.name.clone(), volume))
        .collect();

    let mut mounts = Vec::new();
    let mut env = Vec::new();
    for (container, item) in env_container_names(pod) {
        for mount in item.volume_mounts.iter().flatten() {
            let volume = volumes.get(&mount.name);
            let (values, note) = match volume {
                Some(volume) => mount_values(volume, config_maps, secrets, reveal),
                None => (Vec::new(), Some(format!("volume {} not found", mount.name))),
            };
            mounts.push(PodMount {
                container: container.clone(),
                name: mount.name.clone(),
                path: mount.mount_path.clone(),
                read_only: mount.read_only.unwrap_or(false),
                sub_path: mount.sub_path.clone(),
                source: volume.map(volume_label).unwrap_or_else(|| "missing".to_string()),
                values,
                note,
            });
        }

        for variable in item.env.iter().flatten() {
            let mut entry = PodEnv {
                container: container.clone(),
                name: variable.name.clone(),
                origin: "literal".to_string(),
                key: None,
                value: variable.value.clone().unwrap_or_default(),
                masked: false,
                binary: false,
                note: None,
            };
            if let Some(from) = &variable.value_from {
                if let Some(reference) = &from.config_map_key_ref {
                    entry.origin = format!("configMap {}", reference.name);
                    entry.key = Some(reference.key.clone());
                    match config_maps.get(&reference.name).and_then(|map| {
                        config_entries(map)
                            .into_iter()
                            .find(|(key, _)| key == &reference.key)
                    }) {
                        Some((_, value)) => entry.value = value,
                        None => {
                            entry.note = Some(format!(
                                "key {} missing in ConfigMap {}",
                                reference.key, reference.name
                            ))
                        }
                    }
                } else if let Some(reference) = &from.secret_key_ref {
                    entry.origin = format!("secret {}", reference.name);
                    entry.key = Some(reference.key.clone());
                    match secrets.get(&reference.name).and_then(|secret| {
                        secret_pairs(secret)
                            .into_iter()
                            .find(|(key, _)| key == &reference.key)
                    }) {
                        Some((_, (value, binary))) => {
                            entry.value = value;
                            entry.binary = binary;
                            entry.masked = !reveal;
                        }
                        None => {
                            entry.note = Some(format!(
                                "key {} missing in Secret {}",
                                reference.key, reference.name
                            ))
                        }
                    }
                } else if let Some(reference) = &from.field_ref {
                    entry.origin = format!("fieldRef {}", reference.field_path);
                    match field_value(pod, &reference.field_path) {
                        Some(value) => entry.value = value,
                        None => entry.note = Some("field not set on this pod".to_string()),
                    }
                } else if let Some(reference) = &from.resource_field_ref {
                    entry.origin = format!("resourceFieldRef {}", reference.resource);
                    match resource_value(&item, &reference.resource) {
                        Some(value) => entry.value = value,
                        None => entry.note = Some("no request or limit for it".to_string()),
                    }
                }
            }
            env.push(entry);
        }

        for from in item.env_from.clone().unwrap_or_default() {
            let prefix = from.prefix.clone().unwrap_or_default();
            if let Some(reference) = &from.config_map_ref {
                let mut pushed = 0;
                if let Some(map) = config_maps.get(&reference.name) {
                    for (key, value) in config_entries(map) {
                        env.push(PodEnv {
                            container: container.clone(),
                            name: format!("{prefix}{key}"),
                            origin: format!("configMap {} (envFrom)", reference.name),
                            key: Some(key),
                            value,
                            masked: false,
                            binary: false,
                            note: None,
                        });
                        pushed += 1;
                    }
                }
                if pushed == 0 {
                    env.push(PodEnv {
                        container: container.clone(),
                        name: format!("{prefix}<all keys>"),
                        origin: format!("configMap {} (envFrom)", reference.name),
                        key: None,
                        value: String::new(),
                        masked: false,
                        binary: false,
                        note: Some(format!(
                            "ConfigMap {} not found or not readable",
                            reference.name
                        )),
                    });
                }
            }
            if let Some(reference) = &from.secret_ref {
                let mut pushed = 0;
                if let Some(secret) = secrets.get(&reference.name) {
                    for (key, (value, binary)) in secret_pairs(secret) {
                        env.push(PodEnv {
                            container: container.clone(),
                            name: format!("{prefix}{key}"),
                            origin: format!("secret {} (envFrom)", reference.name),
                            key: Some(key),
                            value,
                            masked: !reveal,
                            binary,
                            note: None,
                        });
                        pushed += 1;
                    }
                }
                if pushed == 0 {
                    env.push(PodEnv {
                        container: container.clone(),
                        name: format!("{prefix}<all keys>"),
                        origin: format!("secret {} (envFrom)", reference.name),
                        key: None,
                        value: String::new(),
                        masked: false,
                        binary: false,
                        note: Some(format!(
                            "Secret {} not found or not readable",
                            reference.name
                        )),
                    });
                }
            }
        }
    }
    (mounts, env)
}

/// Spec facts and live status of every container of a pod, in spec order
/// (init containers after the regular ones). Env and mounts come resolved from
/// [`pod_sources`], so secret values arrive with the reveal flag of the request.
/// Pure, so the whole mapping is testable without a cluster.
fn pod_containers(
    pod: &Pod,
    config_maps: &BTreeMap<String, ConfigMap>,
    secrets: &BTreeMap<String, Secret>,
    reveal: bool,
) -> Vec<PodContainer> {
    let (mounts, env) = pod_sources(pod, config_maps, secrets, reveal);
    let spec = pod.spec.as_ref();
    let statuses: BTreeMap<String, &ContainerStatus> = pod
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.as_deref())
        .map(|statuses| statuses.iter().map(|item| (item.name.clone(), item)).collect())
        .unwrap_or_default();

    let regular = spec.map(|spec| spec.containers.as_slice()).unwrap_or(&[]);
    let init = spec
        .and_then(|spec| spec.init_containers.as_deref())
        .unwrap_or(&[]);
    let mut containers = Vec::new();
    for (group, is_init) in [(regular, false), (init, true)] {
        for container in group {
            let mut info = container_info(container, is_init, &statuses);
            info.env = env
                .iter()
                .filter(|item| item.container == container.name)
                .cloned()
                .collect();
            info.mounts = mounts
                .iter()
                .filter(|item| item.container == container.name)
                .cloned()
                .collect();
            containers.push(info);
        }
    }
    containers
}

fn container_info(
    container: &Container,
    init: bool,
    statuses: &BTreeMap<String, &ContainerStatus>,
) -> PodContainer {
    let ports = container
        .ports
        .iter()
        .flatten()
        .map(|port| {
            let proto = port.protocol.as_deref().unwrap_or("TCP");
            let mut label = format!("{}/{}", port.container_port, proto);
            if let Some(name) = &port.name {
                label.push(' ');
                label.push_str(name);
            }
            if let Some(host) = port.host_port {
                label.push_str(&format!(" (host {host})"));
            }
            label
        })
        .collect();

    let status = statuses.get(&container.name);
    let state = match status.and_then(|status| status.state.as_ref()) {
        Some(state) if state.running.is_some() => "Running".to_string(),
        Some(state) => {
            if let Some(waiting) = &state.waiting {
                format!("Waiting: {}", waiting.reason.as_deref().unwrap_or("…"))
            } else if let Some(terminated) = &state.terminated {
                let reason = terminated.reason.as_deref().unwrap_or("Unknown");
                match terminated.exit_code {
                    0 => format!("Terminated: {reason}"),
                    code => format!("Terminated: {reason} (exit {code})"),
                }
            } else {
                "Unknown".to_string()
            }
        }
        None => "Pending".to_string(),
    };

    PodContainer {
        name: container.name.clone(),
        image: container.image.clone().unwrap_or_default(),
        init,
        ports,
        state,
        ready: status.map(|status| status.ready).unwrap_or(false),
        restarts: status.map(|status| status.restart_count).unwrap_or(0),
        requests: resources_map(
            container
                .resources
                .as_ref()
                .and_then(|item| item.requests.as_ref()),
        ),
        limits: resources_map(
            container
                .resources
                .as_ref()
                .and_then(|item| item.limits.as_ref()),
        ),
        env: Vec::new(),
        mounts: Vec::new(),
    }
}

/// Resource name to quantity text, keys sorted; empty when nothing is set.
fn resources_map(map: Option<&BTreeMap<String, Quantity>>) -> BTreeMap<String, String> {
    map.map(|map| {
        map.iter()
            .map(|(key, value)| (key.clone(), value.0.clone()))
            .collect()
    })
    .unwrap_or_default()
}

/// Names of the ConfigMaps and Secrets a pod refers to, so only those are read.
fn pod_references(pod: &Pod) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut config_maps = BTreeSet::new();
    let mut secrets = BTreeSet::new();
    let Some(spec) = &pod.spec else {
        return (config_maps, secrets);
    };
    for volume in spec.volumes.iter().flatten() {
        for backing in volume_backing(volume) {
            match backing {
                Backing::ConfigMap(name) => {
                    config_maps.insert(name.to_string());
                }
                Backing::Secret(name) => {
                    secrets.insert(name.to_string());
                }
            }
        }
    }
    for (_, container) in env_container_names(pod) {
        for variable in container.env.iter().flatten() {
            if let Some(from) = &variable.value_from {
                if let Some(reference) = &from.config_map_key_ref {
                    config_maps.insert(reference.name.clone());
                }
                if let Some(reference) = &from.secret_key_ref {
                    secrets.insert(reference.name.clone());
                }
            }
        }
        for from in container.env_from.clone().unwrap_or_default() {
            if let Some(reference) = &from.config_map_ref {
                config_maps.insert(reference.name.clone());
            }
            if let Some(reference) = &from.secret_ref {
                secrets.insert(reference.name.clone());
            }
        }
    }
    (config_maps, secrets)
}

async fn load_pod_sources(
    client: &Client,
    namespace: &str,
    name: &str,
    reveal: bool,
) -> Result<(Vec<PodMount>, Vec<PodEnv>), String> {
    let pod = Api::<Pod>::namespaced(client.clone(), namespace)
        .get(name)
        .await
        .map_err(|err| err.to_string())?;
    let (config_maps, secrets) = load_referenced(client, namespace, &pod).await;
    Ok(pod_sources(&pod, &config_maps, &secrets, reveal))
}

async fn load_pod_containers(
    client: &Client,
    namespace: &str,
    name: &str,
    reveal: bool,
) -> Result<Vec<PodContainer>, String> {
    let pod = Api::<Pod>::namespaced(client.clone(), namespace)
        .get(name)
        .await
        .map_err(|err| err.to_string())?;
    let (config_maps, secrets) = load_referenced(client, namespace, &pod).await;
    Ok(pod_containers(&pod, &config_maps, &secrets, reveal))
}

/// Reads the ConfigMaps and Secrets a pod refers to. Unreadable objects are
/// skipped, so the panel can report them as notes instead of failing.
async fn load_referenced(
    client: &Client,
    namespace: &str,
    pod: &Pod,
) -> (BTreeMap<String, ConfigMap>, BTreeMap<String, Secret>) {
    let (wanted_maps, wanted_secrets) = pod_references(pod);

    let map_api = Api::<ConfigMap>::namespaced(client.clone(), namespace);
    let maps = futures::future::join_all(
        wanted_maps
            .iter()
            .map(|item| async { map_api.get(item).await.map(|map| (item.clone(), map)).ok() }),
    )
    .await;
    let config_maps: BTreeMap<String, ConfigMap> = maps.into_iter().flatten().collect();

    let secret_api = Api::<Secret>::namespaced(client.clone(), namespace);
    let found = futures::future::join_all(
        wanted_secrets
            .iter()
            .map(|item| async { secret_api.get(item).await.map(|secret| (item.clone(), secret)).ok() }),
    )
    .await;
    let secrets: BTreeMap<String, Secret> = found.into_iter().flatten().collect();
    (config_maps, secrets)
}

fn secret_text(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), false),
        Err(_) => (base64_encode(bytes), true),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHA[((n >> 18) & 63) as usize] as char);
        out.push(ALPHA[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHA[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHA[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

async fn apply_documents(
    client: &Client,
    yaml: &str,
    fallback_namespace: Option<&str>,
) -> Result<(), String> {
    let docs = yaml_documents(yaml);
    if docs.is_empty() {
        return Err("YAML is empty".to_string());
    }
    for doc in docs {
        apply_document(client, &doc, fallback_namespace).await?;
    }
    Ok(())
}

async fn apply_document(
    client: &Client,
    doc: &str,
    fallback_namespace: Option<&str>,
) -> Result<(), String> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(doc).map_err(|err| format!("Invalid YAML: {err}"))?;
    let json = serde_json::to_value(value).map_err(|err| err.to_string())?;
    let mut object: DynamicObject =
        serde_json::from_value(json).map_err(|err| format!("Not a Kubernetes object: {err}"))?;
    let types = object
        .types
        .clone()
        .ok_or_else(|| "apiVersion and kind are required".to_string())?;
    let (group, version) = split_api_version(&types.api_version);
    let name = object
        .metadata
        .name
        .clone()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "metadata.name is required".to_string())?;
    object.metadata.resource_version = None;
    object.metadata.managed_fields = None;
    let gvk = kube::core::GroupVersionKind::gvk(group, version, &types.kind);
    let (resource, caps) = kube::discovery::pinned_kind(client, &gvk)
        .await
        .map_err(|err| format!("Unknown kind {}/{}: {err}", types.api_version, types.kind))?;
    let namespaced = caps.scope == Scope::Namespaced;
    if namespaced
        && object
            .metadata
            .namespace
            .as_deref()
            .unwrap_or("")
            .is_empty()
    {
        let Some(namespace) = fallback_namespace.filter(|ns| !ns.is_empty()) else {
            return Err(format!(
                "{name}: set metadata.namespace or choose a namespace on the tab"
            ));
        };
        object.metadata.namespace = Some(namespace.to_string());
    }
    let namespace = object.metadata.namespace.clone();
    let api = dynamic_api(client.clone(), &resource, namespaced, &namespace);
    api.patch(
        &name,
        &PatchParams::apply("kubi").force(),
        &Patch::Apply(&object),
    )
    .await
    .map(|_| ())
    .map_err(|err| format!("{name}: {err}"))
}

fn split_api_version(api_version: &str) -> (&str, &str) {
    match api_version.rsplit_once('/') {
        Some((group, version)) => (group, version),
        None => ("", api_version),
    }
}

fn yaml_documents(raw: &str) -> Vec<String> {
    let mut docs = Vec::new();
    let mut current = String::new();
    for line in raw.lines() {
        if line.trim() == "---" {
            if !current.trim().is_empty() {
                docs.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        docs.push(current);
    }
    docs
}

async fn load_detail(
    client: Client,
    context: String,
    target: WatchTarget,
    namespace: String,
    name: String,
    uid: String,
    reveal_secrets: bool,
    events: std::sync::mpsc::Sender<AppEvent>,
) {
    let loaded = match &target {
        WatchTarget::Kind(ResourceKind::ConfigMaps) => {
            load_configmap(client, &namespace, &name).await
        }
        WatchTarget::Kind(ResourceKind::Secrets) => {
            load_secret(client, &namespace, &name, reveal_secrets).await
        }
        WatchTarget::Kind(kind) => yaml_for(client, *kind, &namespace, &name, reveal_secrets)
            .await
            .map(|yaml| (yaml, None)),
        WatchTarget::Custom(target) => {
            let resource =
                resource_of(&target.group, &target.version, &target.kind, &target.plural);
            yaml_dynamic(client, &resource, target.namespaced, &namespace, &name)
                .await
                .map(|yaml| (yaml, None))
        }
    };
    match loaded {
        Ok((yaml, entries)) => {
            let _ = events.send(AppEvent::Yaml {
                context: context.clone(),
                uid: uid.clone(),
                yaml,
            });
            if let Some(entries) = entries {
                let _ = events.send(AppEvent::ObjectData { context, uid, entries });
            }
        }
        Err(err) => {
            let _ = events.send(AppEvent::Error(err));
        }
    }
}

async fn load_configmap(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<(String, Option<Vec<DataEntry>>), String> {
    let item = ns_api::<ConfigMap>(client, namespace)
        .get(name)
        .await
        .map_err(|err| err.to_string())?;
    let value = serde_json::to_value(&item).map_err(|err| err.to_string())?;
    let yaml = crate::yaml::object_to_yaml(value, "v1", "ConfigMap", false)?;
    Ok((yaml, Some(configmap_entries(&item))))
}

async fn load_secret(
    client: Client,
    namespace: &str,
    name: &str,
    reveal_secrets: bool,
) -> Result<(String, Option<Vec<DataEntry>>), String> {
    let item = ns_api::<Secret>(client, namespace)
        .get(name)
        .await
        .map_err(|err| err.to_string())?;
    let value = serde_json::to_value(&item).map_err(|err| err.to_string())?;
    let yaml = crate::yaml::object_to_yaml(value, "v1", "Secret", !reveal_secrets)?;
    Ok((yaml, Some(secret_entries(&item, reveal_secrets))))
}

struct ForwardRequest {
    id: u64,
    namespace: String,
    name: String,
    kind: ResourceKind,
    local_port: u16,
    remote_port: u16,
}

async fn forward_port(
    client: Client,
    request: ForwardRequest,
    cancel: CancellationToken,
    events: std::sync::mpsc::Sender<AppEvent>,
) -> Result<(), String> {
    let ForwardRequest {
        id,
        namespace,
        name,
        kind,
        local_port,
        remote_port,
    } = request;
    let (pod, port) = match kind {
        ResourceKind::Pods => (name.clone(), remote_port),
        ResourceKind::Services => service_target(&client, &namespace, &name, remote_port).await?,
        _ => return Err("Port forward is available for pods and services".to_string()),
    };
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, local_port))
        .await
        .map_err(|err| format!("local port {local_port}: {err}"))?;
    let _ = events.send(AppEvent::PortForwardStarted {
        id,
        namespace: namespace.clone(),
        name,
        local_port,
        remote_port: port,
    });
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            accepted = listener.accept() => {
                let (tcp, _) = accepted.map_err(|err| err.to_string())?;
                let client = client.clone();
                let namespace = namespace.clone();
                let pod = pod.clone();
                tokio::spawn(async move {
                    bridge_forward(client, namespace, pod, port, tcp).await;
                });
            }
        }
    }
}

async fn bridge_forward(
    client: Client,
    namespace: String,
    pod: String,
    port: u16,
    mut tcp: tokio::net::TcpStream,
) {
    let api = Api::<Pod>::namespaced(client, &namespace);
    let Ok(mut forwarded) = api.portforward(&pod, &[port]).await else {
        return;
    };
    let Some(mut remote) = forwarded.take_stream(port) else {
        forwarded.abort();
        return;
    };
    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut remote).await;
    forwarded.abort();
}

async fn service_target(
    client: &Client,
    namespace: &str,
    name: &str,
    remote_port: u16,
) -> Result<(String, u16), String> {
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
    let service = Api::<Service>::namespaced(client.clone(), namespace)
        .get(name)
        .await
        .map_err(|err| err.to_string())?;
    let ports = service.spec.and_then(|spec| spec.ports).unwrap_or_default();
    let chosen = ports
        .iter()
        .find(|port| u16::try_from(port.port).ok() == Some(remote_port));
    let named = chosen.and_then(|port| match &port.target_port {
        Some(IntOrString::String(name)) => Some(name.clone()),
        _ => None,
    });
    let numbered = chosen.and_then(|port| match &port.target_port {
        Some(IntOrString::Int(number)) => u16::try_from(*number).ok(),
        None => u16::try_from(port.port).ok(),
        Some(IntOrString::String(_)) => None,
    });
    let selector = format!("kubernetes.io/service-name={name}");
    let slices = list_labeled(
        Api::<EndpointSlice>::namespaced(client.clone(), namespace),
        &selector,
    )
    .await?;
    for slice in &slices {
        let Some(port) = slice.ports.iter().flatten().find_map(|port| {
            let number = port.port.and_then(|value| u16::try_from(value).ok())?;
            let matches = if let Some(named) = &named {
                port.name.as_ref() == Some(named)
            } else if let Some(numbered) = numbered {
                number == numbered
            } else {
                number == remote_port
            };
            matches.then_some(number)
        }) else {
            continue;
        };
        for endpoint in slice.endpoints.iter().flatten() {
            let ready = endpoint
                .conditions
                .as_ref()
                .and_then(|conditions| conditions.ready)
                .unwrap_or(true);
            if !ready {
                continue;
            }
            let Some(pod) = endpoint.target_ref.as_ref().and_then(|reference| {
                (reference.kind.as_deref() == Some("Pod"))
                    .then(|| reference.name.clone())
                    .flatten()
            }) else {
                continue;
            };
            return Ok((pod, port));
        }
    }
    Err(format!(
        "no ready pod for service {name} port {remote_port}"
    ))
}

struct ExecRequest {
    id: u64,
    namespace: String,
    name: String,
    container: Option<String>,
}

async fn run_exec(
    client: Client,
    request: ExecRequest,
    cancel: CancellationToken,
    mut input: tokio::sync::mpsc::UnboundedReceiver<ExecMsg>,
    events: std::sync::mpsc::Sender<AppEvent>,
) -> Result<(), String> {
    let ExecRequest {
        id,
        namespace,
        name,
        container,
    } = request;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let api = Api::<Pod>::namespaced(client, &namespace);
    let pod = api.get(&name).await.map_err(|err| err.to_string())?;
    if cancel.is_cancelled() {
        return Ok(());
    }
    let containers = pod_container_names(&pod);
    if containers.is_empty() {
        return Err("pod has no containers".to_string());
    }
    let selected = container
        .filter(|item| containers.iter().any(|name| name == item))
        .unwrap_or_else(|| containers[0].clone());
    let _ = events.send(AppEvent::ExecStarted {
        id,
        namespace: namespace.clone(),
        name: name.clone(),
        container: selected.clone(),
        containers,
    });
    let mut attached = api
        .exec(
            &name,
            ["sh"],
            &kube::api::AttachParams {
                container: Some(selected),
                stdin: true,
                stdout: true,
                stderr: false,
                tty: true,
                max_stdin_buf_size: Some(64 * 1024),
                max_stdout_buf_size: Some(64 * 1024),
                max_stderr_buf_size: None,
            },
        )
        .await
        .map_err(|err| err.to_string())?;
    let mut stdin = attached
        .stdin()
        .ok_or_else(|| "exec has no stdin".to_string())?;
    let mut stdout = attached
        .stdout()
        .ok_or_else(|| "exec has no stdout".to_string())?;
    let mut resize = attached.terminal_size();
    let mut buf = vec![0u8; 4096];
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            message = input.recv() => {
                match message {
                    None => break,
                    Some(ExecMsg::Data(bytes)) => {
                        if stdin.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    Some(ExecMsg::Resize { cols, rows }) => {
                        if let Some(sender) = resize.as_mut() {
                            let _ = sender
                                .send(kube::api::TerminalSize { width: cols, height: rows })
                                .await;
                        }
                    }
                }
            }
            read = stdout.read(&mut buf) => {
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        let text = String::from_utf8_lossy(&buf[..size]).into_owned();
                        let _ = events.send(AppEvent::ExecData { id, text });
                    }
                }
            }
        }
    }
    attached.abort();
    Ok(())
}

#[cfg(test)]
mod overview_tests {
    use super::{
        app_set_status, argo_cluster, argo_repo, pod_phases, secret_text, selector_query,
        split_api_version, yaml_documents,
    };
    use std::collections::BTreeMap;

    use k8s_openapi::api::core::v1::{Pod, Secret};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{
        LabelSelector, LabelSelectorRequirement, ObjectMeta,
    };
    use k8s_openapi::ByteString;

    #[test]
    fn formats_workload_label_selector() {
        let selector = LabelSelector {
            match_labels: Some(BTreeMap::from([
                ("app".to_string(), "web".to_string()),
                ("tier".to_string(), "front".to_string()),
            ])),
            match_expressions: Some(vec![
                LabelSelectorRequirement {
                    key: "env".into(),
                    operator: "In".into(),
                    values: Some(vec!["prod".into(), "stage".into()]),
                },
                LabelSelectorRequirement {
                    key: "track".into(),
                    operator: "NotIn".into(),
                    values: Some(vec!["canary".into()]),
                },
                LabelSelectorRequirement {
                    key: "region".into(),
                    operator: "Exists".into(),
                    values: None,
                },
                LabelSelectorRequirement {
                    key: "debug".into(),
                    operator: "DoesNotExist".into(),
                    values: None,
                },
            ]),
        };
        assert_eq!(
            selector_query(&selector),
            "app=web,tier=front,env in (prod,stage),track notin (canary),region,!debug"
        );
        assert_eq!(selector_query(&LabelSelector::default()), "");
    }

    #[test]
    fn splits_api_version() {
        assert_eq!(split_api_version("v1"), ("", "v1"));
        assert_eq!(split_api_version("apps/v1"), ("apps", "v1"));
        assert_eq!(
            split_api_version("gateway.networking.k8s.io/v1"),
            ("gateway.networking.k8s.io", "v1")
        );
    }

    #[test]
    fn splits_yaml_documents() {
        let docs = yaml_documents("a: 1\n---\n\n---\nb: 2\n");
        assert_eq!(docs.len(), 2);
        assert!(docs[0].contains("a: 1"));
        assert!(docs[1].contains("b: 2"));
    }

    #[test]
    fn counts_pod_phases() {
        let running: Pod = serde_json::from_value(serde_json::json!({
            "status": {"phase": "Running"}
        }))
        .unwrap();
        let pending: Pod =
            serde_json::from_value(serde_json::json!({"status": {"phase": "Pending"}})).unwrap();
        let (running_n, pending_n, failed, succeeded, unknown) = pod_phases(&[running, pending]);
        assert_eq!(
            (running_n, pending_n, failed, succeeded, unknown),
            (1, 1, 0, 0, 0)
        );
    }

    #[test]
    fn decodes_secret_text() {
        assert_eq!(secret_text(b"hello").0, "hello");
        assert!(!secret_text(b"hello").1);
        let (encoded, binary) = secret_text(&[0, 255, 1]);
        assert!(binary);
        assert_eq!(encoded, "AP8B");
    }

    #[test]
    fn reads_argo_repo_and_cluster_without_credentials() {
        let repo = Secret {
            metadata: ObjectMeta {
                name: Some("repo-1".to_string()),
                ..ObjectMeta::default()
            },
            data: Some(
                [
                    ("name", "payments"),
                    ("url", "https://git.example/payments"),
                    ("type", "git"),
                    ("project", "default"),
                    ("password", "super-secret"),
                ]
                .into_iter()
                .map(|(key, value)| (key.to_string(), ByteString(value.as_bytes().to_vec())))
                .collect(),
            ),
            ..Secret::default()
        };
        let parsed = argo_repo(&repo);
        assert_eq!(parsed.name, "payments");
        assert_eq!(parsed.url, "https://git.example/payments");
        assert_eq!(parsed.repo_type, "git");
        assert_eq!(parsed.project, "default");
        assert!(!format!("{parsed:?}").contains("super-secret"));

        let cluster = Secret {
            metadata: ObjectMeta {
                name: Some("cluster-1".to_string()),
                ..ObjectMeta::default()
            },
            data: Some(
                [
                    ("name", "prod"),
                    ("server", "https://kube.example"),
                    ("config", r#"{"bearerToken":"token-value"}"#),
                ]
                .into_iter()
                .map(|(key, value)| (key.to_string(), ByteString(value.as_bytes().to_vec())))
                .collect(),
            ),
            ..Secret::default()
        };
        let parsed = argo_cluster(&cluster);
        assert_eq!(parsed.name, "prod");
        assert_eq!(parsed.server, "https://kube.example");
        assert!(!format!("{parsed:?}").contains("token-value"));
    }

    #[test]
    fn maps_pod_owner_to_workload() {
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
        fn owner(kind: &str, name: &str) -> OwnerReference {
            OwnerReference {
                api_version: "apps/v1".to_string(),
                kind: kind.to_string(),
                name: name.to_string(),
                uid: "1".to_string(),
                controller: Some(true),
                block_owner_deletion: None,
            }
        }
        let set = owner("ReplicaSet", "payments-6d4f");
        let deployment = owner("Deployment", "payments");
        let (kind, name) = super::workload_target(Some(&set), Some(&deployment)).unwrap();
        assert_eq!(kind, crate::model::ResourceKind::Deployments);
        assert_eq!(name, "payments");
        let stateful = owner("StatefulSet", "db");
        let (kind, name) = super::workload_target(Some(&stateful), None).unwrap();
        assert_eq!(kind, crate::model::ResourceKind::StatefulSets);
        assert_eq!(name, "db");
        assert!(super::workload_target(None, None).is_err());
        let job = owner("Job", "migrate");
        assert!(super::workload_target(Some(&job), None).is_err());
    }

    #[test]
    fn reads_application_set_status() {
        let error = serde_json::json!({
            "status": {
                "conditions": [{"type": "ErrorOccurred", "status": "True", "message": "boom"}]
            }
        });
        assert_eq!(app_set_status(&error), "boom");
        let healthy = serde_json::json!({
            "status": {
                "conditions": [{"type": "ResourcesUpToDate", "status": "True"}]
            }
        });
        assert_eq!(app_set_status(&healthy), "Healthy");
        assert_eq!(app_set_status(&serde_json::json!({})), "Unknown");
    }
}

#[cfg(test)]
mod event_tests {
    use super::*;
    use k8s_openapi::api::core::v1::{EventSeries, EventSource, ObjectReference};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};

    fn ago(secs: i64) -> Time {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        Time(k8s_openapi::jiff::Timestamp::from_second(now - secs).unwrap())
    }

    fn event(reason: &str, kind: &str, at: Option<Time>) -> Event {
        Event {
            metadata: ObjectMeta {
                name: Some(reason.to_string()),
                creation_timestamp: at,
                ..ObjectMeta::default()
            },
            type_: Some(kind.to_string()),
            reason: Some(reason.to_string()),
            message: Some(format!("{reason} happened")),
            ..Event::default()
        }
    }

    #[test]
    fn warnings_first_then_newest() {
        let mut events = vec![
            to_event_info(&event("Scheduled", "Normal", Some(ago(300)))),
            to_event_info(&event("Pulled", "Normal", Some(ago(20)))),
            to_event_info(&event("Unhealthy", "Warning", Some(ago(120)))),
            to_event_info(&event("BackOff", "Warning", Some(ago(5)))),
        ];
        sort_events(&mut events);
        let order: Vec<&str> = events.iter().map(|item| item.reason.as_str()).collect();
        assert_eq!(order, ["BackOff", "Unhealthy", "Pulled", "Scheduled"]);
        assert!(events[0].age_secs.unwrap() < events[1].age_secs.unwrap());
    }

    #[test]
    fn count_and_source_fall_back() {
        let mut series = event("Unhealthy", "Warning", Some(ago(10)));
        series.count = None;
        series.series = Some(EventSeries {
            count: Some(25),
            ..EventSeries::default()
        });
        series.reporting_component = Some("kubelet".to_string());
        let info = to_event_info(&series);
        assert_eq!(info.count, 25);
        assert_eq!(info.source, "kubelet");
        assert_eq!(info.message, "Unhealthy happened");

        // A source block wins over the reporting component, and a lone event counts once.
        let mut plain = event("Pulled", "Normal", Some(ago(30)));
        plain.source = Some(EventSource {
            component: Some("kubelet".to_string()),
            ..EventSource::default()
        });
        plain.reporting_component = Some("ignored".to_string());
        let info = to_event_info(&plain);
        assert_eq!(info.count, 1);
        assert_eq!(info.source, "kubelet");
    }

    #[test]
    fn missing_kind_and_timestamp_are_handled() {
        let mut bare = event("Created", "Normal", None);
        bare.type_ = None;
        let info = to_event_info(&bare);
        assert_eq!(info.kind, "Normal");
        assert!(info.age_secs.is_none());
        assert_eq!(info.source, "");

        // No timestamp sinks below dated events of the same kind.
        let mut events = vec![
            to_event_info(&bare),
            to_event_info(&event("Started", "Normal", Some(ago(60)))),
        ];
        sort_events(&mut events);
        assert_eq!(events[0].reason, "Started");
        assert_eq!(events[1].reason, "Created");
    }

    #[test]
    fn limit_is_bounded() {
        let mut events: Vec<EventInfo> = (0..EVENT_LIMIT + 20)
            .map(|index| to_event_info(&event(&format!("R{index}"), "Normal", Some(ago(index as i64)))))
            .collect();
        sort_events(&mut events);
        events.truncate(EVENT_LIMIT);
        assert_eq!(events.len(), EVENT_LIMIT);
        assert_eq!(events[0].reason, "R0");
    }

    fn warning(reason: &str, uid: &str, name: &str, count: i32, at: Option<Time>) -> Event {
        let mut event = event(reason, "Warning", at);
        event.count = Some(count);
        event.involved_object = ObjectReference {
            uid: Some(uid.to_string()),
            name: Some(name.to_string()),
            namespace: Some("apps".to_string()),
            ..ObjectReference::default()
        };
        event
    }

    #[test]
    fn aggregates_warnings_per_object() {
        let list = aggregate_warnings(&[
            warning("Unhealthy", "u1", "pod-a", 5, Some(ago(300))),
            warning("BackOff", "u1", "pod-a", 2, Some(ago(20))),
            warning("FailedMount", "u2", "pod-b", 1, Some(ago(60))),
        ]);
        assert_eq!(list.len(), 2);
        // Loudest first, counts added up, reason from the newest occurrence.
        assert_eq!(list[0].uid, "u1");
        assert_eq!(list[0].name, "pod-a");
        assert_eq!(list[0].namespace, "apps");
        assert_eq!(list[0].count, 7);
        assert_eq!(list[0].reason, "BackOff");
        assert!(list[0].age_secs.unwrap() < 60);
        assert_eq!(list[1].uid, "u2");
        assert_eq!(list[1].reason, "FailedMount");
    }

    #[test]
    fn warnings_without_uid_are_skipped() {
        let mut orphan = event("Orphan", "Warning", Some(ago(10)));
        orphan.count = Some(3);
        assert!(aggregate_warnings(&[orphan]).is_empty());
    }

    #[test]
    fn probe_only_tracks_probe_trouble() {
        let list = aggregate_warnings(&[
            warning("Unhealthy", "u1", "pod-a", 4, Some(ago(30))),
            warning("FailedMount", "u2", "pod-b", 1, Some(ago(30))),
        ]);
        let by_uid = |uid: &str| list.iter().find(|item| item.uid == uid).unwrap();
        assert!(by_uid("u1").probe_only);
        assert!(!by_uid("u2").probe_only);

        // One real warning alongside a probe failure is enough to keep it.
        let mixed = aggregate_warnings(&[
            warning("Unhealthy", "u3", "pod-c", 9, Some(ago(10))),
            warning("BackOff", "u3", "pod-c", 1, Some(ago(20))),
        ]);
        assert!(!mixed[0].probe_only);
        assert_eq!(mixed[0].count, 10);
        assert_eq!(mixed[0].reason, "Unhealthy");
    }

    #[test]
    fn probe_messages_are_recognised() {
        let mut by_message = event("SomeReason", "Warning", Some(ago(5)));
        by_message.message = Some("Readiness probe errored: connection refused".to_string());
        assert!(is_probe_warning(&by_message));

        let mut normal = event("Scheduled", "Normal", Some(ago(5)));
        normal.message = Some("Successfully assigned apps/pod to node-1".to_string());
        assert!(!is_probe_warning(&normal));

        let mut spec = event("FailedScheduling", "Warning", Some(ago(5)));
        spec.message = Some("0/3 nodes are available: 3 Insufficient cpu".to_string());
        assert!(!is_probe_warning(&spec));
    }
}

#[cfg(test)]
mod source_tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        ConfigMapEnvSource, ConfigMapKeySelector, ConfigMapProjection, ConfigMapVolumeSource,
        EnvFromSource, EnvVar, EnvVarSource, KeyToPath, ObjectFieldSelector, PodSpec,
        ProjectedVolumeSource, ResourceFieldSelector, ResourceRequirements, SecretEnvSource,
        SecretKeySelector, SecretProjection, SecretVolumeSource, VolumeMount, VolumeProjection,
    };
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use k8s_openapi::ByteString;

    fn pod() -> Pod {
        let mount = |name: &str, path: &str, read_only: bool, sub_path: Option<&str>| VolumeMount {
            name: name.to_string(),
            mount_path: path.to_string(),
            read_only: Some(read_only),
            sub_path: sub_path.map(str::to_string),
            ..VolumeMount::default()
        };
        let env = |name: &str, value: &str| EnvVar {
            name: name.to_string(),
            value: Some(value.to_string()),
            ..EnvVar::default()
        };
        Pod {
            metadata: ObjectMeta {
                name: Some("app-0".to_string()),
                namespace: Some("apps".to_string()),
                uid: Some("uid-1".to_string()),
                ..ObjectMeta::default()
            },
            spec: Some(PodSpec {
                node_name: Some("node-a".to_string()),
                service_account_name: Some("app-sa".to_string()),
                containers: vec![Container {
                    name: "app".to_string(),
                    volume_mounts: Some(vec![
                        mount("config", "/etc/app", false, None),
                        mount("creds", "/etc/creds", true, Some("password")),
                        mount("scratch", "/tmp", false, None),
                        mount("projected", "/etc/projected", false, None),
                    ]),
                    env: Some(vec![
                        env("LOG_LEVEL", "debug"),
                        EnvVar {
                            name: "FEATURE_FLAG".to_string(),
                            value_from: Some(EnvVarSource {
                                config_map_key_ref: Some(ConfigMapKeySelector {
                                    name: "app-config".to_string(),
                                    key: "FEATURE_FLAG".to_string(),
                                    ..ConfigMapKeySelector::default()
                                }),
                                ..EnvVarSource::default()
                            }),
                            ..EnvVar::default()
                        },
                        EnvVar {
                            name: "DB_PASSWORD".to_string(),
                            value_from: Some(EnvVarSource {
                                secret_key_ref: Some(SecretKeySelector {
                                    name: "db-creds".to_string(),
                                    key: "password".to_string(),
                                    ..SecretKeySelector::default()
                                }),
                                ..EnvVarSource::default()
                            }),
                            ..EnvVar::default()
                        },
                        EnvVar {
                            name: "NODE".to_string(),
                            value_from: Some(EnvVarSource {
                                field_ref: Some(ObjectFieldSelector {
                                    field_path: "spec.nodeName".to_string(),
                                    ..ObjectFieldSelector::default()
                                }),
                                ..EnvVarSource::default()
                            }),
                            ..EnvVar::default()
                        },
                        EnvVar {
                            name: "CPU_LIMIT".to_string(),
                            value_from: Some(EnvVarSource {
                                resource_field_ref: Some(ResourceFieldSelector {
                                    resource: "limits.cpu".to_string(),
                                    ..ResourceFieldSelector::default()
                                }),
                                ..EnvVarSource::default()
                            }),
                            ..EnvVar::default()
                        },
                        EnvVar {
                            name: "GONE".to_string(),
                            value_from: Some(EnvVarSource {
                                config_map_key_ref: Some(ConfigMapKeySelector {
                                    name: "app-config".to_string(),
                                    key: "MISSING".to_string(),
                                    ..ConfigMapKeySelector::default()
                                }),
                                ..EnvVarSource::default()
                            }),
                            ..EnvVar::default()
                        },
                    ]),
                    env_from: Some(vec![
                        EnvFromSource {
                            prefix: Some("CFG_".to_string()),
                            config_map_ref: Some(ConfigMapEnvSource {
                                name: "app-config".to_string(),
                                ..ConfigMapEnvSource::default()
                            }),
                            ..EnvFromSource::default()
                        },
                        EnvFromSource {
                            secret_ref: Some(SecretEnvSource {
                                name: "db-creds".to_string(),
                                ..SecretEnvSource::default()
                            }),
                            ..EnvFromSource::default()
                        },
                        EnvFromSource {
                            config_map_ref: Some(ConfigMapEnvSource {
                                name: "absent".to_string(),
                                ..ConfigMapEnvSource::default()
                            }),
                            ..EnvFromSource::default()
                        },
                    ]),
                    resources: Some(ResourceRequirements {
                        limits: Some(BTreeMap::from([(
                            "cpu".to_string(),
                            Quantity("500m".to_string()),
                        )])),
                        ..ResourceRequirements::default()
                    }),
                    ..Container::default()
                }],
                init_containers: Some(vec![Container {
                    name: "init".to_string(),
                    volume_mounts: Some(vec![mount("config", "/init", false, None)]),
                    ..Container::default()
                }]),
                volumes: Some(vec![
                    Volume {
                        name: "config".to_string(),
                        config_map: Some(ConfigMapVolumeSource {
                            name: "app-config".to_string(),
                            ..ConfigMapVolumeSource::default()
                        }),
                        ..Volume::default()
                    },
                    Volume {
                        name: "creds".to_string(),
                        secret: Some(SecretVolumeSource {
                            secret_name: Some("db-creds".to_string()),
                            ..SecretVolumeSource::default()
                        }),
                        ..Volume::default()
                    },
                    Volume {
                        name: "scratch".to_string(),
                        empty_dir: Some(Default::default()),
                        ..Volume::default()
                    },
                    Volume {
                        name: "projected".to_string(),
                        projected: Some(ProjectedVolumeSource {
                            sources: Some(vec![
                                VolumeProjection {
                                    config_map: Some(ConfigMapProjection {
                                        name: "app-config".to_string(),
                                        items: Some(vec![KeyToPath {
                                            key: "FEATURE_FLAG".to_string(),
                                            path: "flag".to_string(),
                                            ..KeyToPath::default()
                                        }]),
                                        ..ConfigMapProjection::default()
                                    }),
                                    ..VolumeProjection::default()
                                },
                                VolumeProjection {
                                    secret: Some(SecretProjection {
                                        name: "db-creds".to_string(),
                                        ..SecretProjection::default()
                                    }),
                                    ..VolumeProjection::default()
                                },
                            ]),
                            ..ProjectedVolumeSource::default()
                        }),
                        ..Volume::default()
                    },
                ]),
                ..PodSpec::default()
            }),
            ..Pod::default()
        }
    }

    fn maps() -> (BTreeMap<String, ConfigMap>, BTreeMap<String, Secret>) {
        let config_maps = BTreeMap::from([(
            "app-config".to_string(),
            ConfigMap {
                metadata: ObjectMeta {
                    name: Some("app-config".to_string()),
                    ..ObjectMeta::default()
                },
                data: Some(BTreeMap::from([
                    ("FEATURE_FLAG".to_string(), "on".to_string()),
                    ("LOG_LEVEL".to_string(), "info".to_string()),
                ])),
                ..ConfigMap::default()
            },
        )]);
        let secrets = BTreeMap::from([(
            "db-creds".to_string(),
            Secret {
                metadata: ObjectMeta {
                    name: Some("db-creds".to_string()),
                    ..ObjectMeta::default()
                },
                data: Some(BTreeMap::from([(
                    "password".to_string(),
                    ByteString(b"s3cr3t".to_vec()),
                )])),
                ..Secret::default()
            },
        )]);
        (config_maps, secrets)
    }

    #[test]
    fn reads_only_the_referenced_objects() {
        let (maps, secrets) = pod_references(&pod());
        assert_eq!(maps.into_iter().collect::<Vec<_>>(), ["absent", "app-config"]);
        assert_eq!(secrets.into_iter().collect::<Vec<_>>(), ["db-creds"]);
    }

    #[test]
    fn lists_mounts_with_their_source_and_values() {
        let (config_maps, secrets) = maps();
        let (mounts, _) = pod_sources(&pod(), &config_maps, &secrets, false);
        let find = |name: &str, container: &str| {
            mounts
                .iter()
                .find(|item| item.name == name && item.container == container)
                .unwrap()
        };
        let config = find("config", "app");
        assert_eq!(config.path, "/etc/app");
        assert_eq!(config.source, "configMap app-config");
        assert!(!config.read_only);
        assert_eq!(
            config.values.iter().map(|item| item.key.as_str()).collect::<Vec<_>>(),
            ["FEATURE_FLAG", "LOG_LEVEL"]
        );
        assert_eq!(config.values[0].value, "on");

        let creds = find("creds", "app");
        assert!(creds.read_only);
        assert_eq!(creds.sub_path.as_deref(), Some("password"));
        // The value travels, the flag tells the UI to hide it.
        assert!(creds.values[0].masked);
        assert_eq!(creds.values[0].value, "s3cr3t");

        assert_eq!(find("scratch", "app").source, "emptyDir");
        assert!(find("scratch", "app").values.is_empty());

        let projected = find("projected", "app");
        assert_eq!(projected.source, "projected");
        // Only the key named in `items` plus the whole secret.
        assert_eq!(
            projected.values.iter().map(|item| item.key.as_str()).collect::<Vec<_>>(),
            ["FEATURE_FLAG", "password"]
        );

        // Init containers mount the same volume.
        assert_eq!(find("config", "init").path, "/init");
    }

    #[test]
    fn reveals_secret_values_on_request() {
        let (config_maps, secrets) = maps();
        let (mounts, env) = pod_sources(&pod(), &config_maps, &secrets, true);
        assert_eq!(mounts[1].values[0].value, "s3cr3t");
        assert!(!mounts[1].values[0].masked);
        let password = env.iter().find(|item| item.name == "DB_PASSWORD").unwrap();
        assert_eq!(password.value, "s3cr3t");
        assert!(!password.masked);
    }

    #[test]
    fn resolves_every_kind_of_env_source() {
        let (config_maps, secrets) = maps();
        let (_, env) = pod_sources(&pod(), &config_maps, &secrets, false);
        let get = |name: &str| env.iter().find(|item| item.name == name).unwrap().clone();

        assert_eq!(get("LOG_LEVEL").origin, "literal");
        assert_eq!(get("LOG_LEVEL").value, "debug");

        let flag = get("FEATURE_FLAG");
        assert_eq!(flag.origin, "configMap app-config");
        assert_eq!(flag.key.as_deref(), Some("FEATURE_FLAG"));
        assert_eq!(flag.value, "on");

        let password = get("DB_PASSWORD");
        assert_eq!(password.origin, "secret db-creds");
        assert_eq!(password.value, "s3cr3t");
        assert!(password.masked);

        assert_eq!(get("NODE").origin, "fieldRef spec.nodeName");
        assert_eq!(get("NODE").value, "node-a");

        assert_eq!(get("CPU_LIMIT").origin, "resourceFieldRef limits.cpu");
        assert_eq!(get("CPU_LIMIT").value, "500m");

        let missing = get("GONE");
        assert_eq!(missing.value, "");
        assert_eq!(
            missing.note.as_deref(),
            Some("key MISSING missing in ConfigMap app-config")
        );

        // envFrom expands every key, honours the prefix and reports a miss.
        let prefixed = get("CFG_LOG_LEVEL");
        assert_eq!(prefixed.value, "info");
        assert_eq!(prefixed.origin, "configMap app-config (envFrom)");
        let from_secret = get("password");
        assert_eq!(from_secret.value, "s3cr3t");
        assert!(from_secret.masked);
        assert_eq!(from_secret.origin, "secret db-creds (envFrom)");
        let absent = env
            .iter()
            .find(|item| item.origin == "configMap absent (envFrom)")
            .unwrap();
        assert!(absent.note.is_some());
        assert_eq!(absent.value, "");
    }

    #[test]
    fn reports_unreadable_sources_instead_of_failing() {
        let empty: BTreeMap<String, ConfigMap> = BTreeMap::new();
        let no_secrets: BTreeMap<String, Secret> = BTreeMap::new();
        let (mounts, env) = pod_sources(&pod(), &empty, &no_secrets, false);
        let config = mounts.iter().find(|item| item.name == "config").unwrap();
        assert_eq!(
            config.note.as_deref(),
            Some("ConfigMap app-config not found or not readable")
        );
        assert!(config.values.is_empty());
        let password = env.iter().find(|item| item.name == "DB_PASSWORD").unwrap();
        assert_eq!(
            password.note.as_deref(),
            Some("key password missing in Secret db-creds")
        );
    }
}

#[cfg(test)]
mod container_tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        ContainerPort, ContainerState, ContainerStateRunning, ContainerStateTerminated,
        ContainerStateWaiting, ContainerStatus, EnvFromSource, EnvVar, EnvVarSource, PodSpec,
        PodStatus, ResourceRequirements, SecretEnvSource, SecretKeySelector, SecretVolumeSource,
        VolumeMount,
    };
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;

    fn quantities(items: &[(&str, &str)]) -> BTreeMap<String, Quantity> {
        items
            .iter()
            .map(|(key, value)| (key.to_string(), Quantity(value.to_string())))
            .collect()
    }

    #[test]
    fn lists_containers_with_ports_status_resources_env_and_mounts() {
        let pod = Pod {
            spec: Some(PodSpec {
                containers: vec![Container {
                    name: "app".to_string(),
                    image: Some("nginx:1.27".to_string()),
                    ports: Some(vec![ContainerPort {
                        container_port: 8080,
                        name: Some("http".to_string()),
                        protocol: Some("TCP".to_string()),
                        ..ContainerPort::default()
                    }]),
                    env: Some(vec![
                        EnvVar {
                            name: "MODE".to_string(),
                            value: Some("prod".to_string()),
                            ..EnvVar::default()
                        },
                        EnvVar {
                            name: "DB_PASSWORD".to_string(),
                            value_from: Some(EnvVarSource {
                                secret_key_ref: Some(SecretKeySelector {
                                    name: "db".to_string(),
                                    key: "password".to_string(),
                                    ..SecretKeySelector::default()
                                }),
                                ..EnvVarSource::default()
                            }),
                            ..EnvVar::default()
                        },
                    ]),
                    env_from: Some(vec![EnvFromSource {
                        prefix: Some("APP_".to_string()),
                        secret_ref: Some(SecretEnvSource {
                            name: "shared".to_string(),
                            ..SecretEnvSource::default()
                        }),
                        ..EnvFromSource::default()
                    }]),
                    volume_mounts: Some(vec![
                        VolumeMount {
                            name: "creds".to_string(),
                            mount_path: "/etc/creds".to_string(),
                            read_only: Some(true),
                            sub_path: Some("password".to_string()),
                            ..VolumeMount::default()
                        },
                        VolumeMount {
                            name: "ghost".to_string(),
                            mount_path: "/gone".to_string(),
                            ..VolumeMount::default()
                        },
                    ]),
                    resources: Some(ResourceRequirements {
                        requests: Some(quantities(&[("cpu", "50m"), ("memory", "64Mi")])),
                        limits: Some(quantities(&[("cpu", "1")])),
                        ..ResourceRequirements::default()
                    }),
                    ..Container::default()
                }],
                init_containers: Some(vec![Container {
                    name: "init".to_string(),
                    ..Container::default()
                }]),
                volumes: Some(vec![Volume {
                    name: "creds".to_string(),
                    secret: Some(SecretVolumeSource {
                        secret_name: Some("creds".to_string()),
                        ..SecretVolumeSource::default()
                    }),
                    ..Volume::default()
                }]),
                ..PodSpec::default()
            }),
            status: Some(PodStatus {
                container_statuses: Some(vec![ContainerStatus {
                    name: "app".to_string(),
                    ready: true,
                    restart_count: 3,
                    state: Some(ContainerState {
                        running: Some(ContainerStateRunning::default()),
                        ..ContainerState::default()
                    }),
                    ..ContainerStatus::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        let empty_maps: BTreeMap<String, ConfigMap> = BTreeMap::new();
        let empty_secrets: BTreeMap<String, Secret> = BTreeMap::new();
        let containers = pod_containers(&pod, &empty_maps, &empty_secrets, false);
        assert_eq!(containers.len(), 2);

        let app = &containers[0];
        assert_eq!(app.name, "app");
        assert_eq!(app.image, "nginx:1.27");
        assert!(!app.init);
        assert_eq!(app.ports, vec!["8080/TCP http"]);
        assert_eq!(app.state, "Running");
        assert!(app.ready);
        assert_eq!(app.restarts, 3);
        assert_eq!(app.requests.get("cpu").map(String::as_str), Some("50m"));
        assert_eq!(
            app.requests.get("memory").map(String::as_str),
            Some("64Mi")
        );
        assert_eq!(app.limits.get("cpu").map(String::as_str), Some("1"));
        assert!(app.limits.get("memory").is_none());

        assert_eq!(app.env[0].name, "MODE");
        assert_eq!(app.env[0].value, "prod");
        assert_eq!(app.env[1].origin, "secret db");
        assert_eq!(app.env[1].key.as_deref(), Some("password"));
        assert!(app.env[1].note.is_some());
        assert_eq!(app.env[2].name, "APP_<all keys>");
        assert_eq!(app.env[2].origin, "secret shared (envFrom)");

        assert_eq!(app.mounts.len(), 2);
        assert_eq!(app.mounts[0].source, "secret creds");
        assert!(app.mounts[0].read_only);
        assert_eq!(app.mounts[1].source, "missing");
        assert!(app.mounts[1].note.is_some());

        let init = &containers[1];
        assert!(init.init);
        assert_eq!(init.state, "Pending");
        assert!(!init.ready);
        assert_eq!(init.restarts, 0);
    }

    #[test]
    fn reports_waiting_reason_and_terminated_exit_code() {
        let status_of = |state: ContainerState| ContainerStatus {
            name: "app".to_string(),
            state: Some(state),
            ..ContainerStatus::default()
        };
        let pod = |state: ContainerState| Pod {
            spec: Some(PodSpec {
                containers: vec![Container {
                    name: "app".to_string(),
                    ..Container::default()
                }],
                ..PodSpec::default()
            }),
            status: Some(PodStatus {
                container_statuses: Some(vec![status_of(state)]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };

        let waiting = pod(ContainerState {
            waiting: Some(ContainerStateWaiting {
                reason: Some("CrashLoopBackOff".to_string()),
                ..ContainerStateWaiting::default()
            }),
            ..ContainerState::default()
        });
        let empty_maps: BTreeMap<String, ConfigMap> = BTreeMap::new();
        let empty_secrets: BTreeMap<String, Secret> = BTreeMap::new();
        assert_eq!(
            pod_containers(&waiting, &empty_maps, &empty_secrets, false)[0].state,
            "Waiting: CrashLoopBackOff"
        );

        let terminated = pod(ContainerState {
            terminated: Some(ContainerStateTerminated {
                reason: Some("Error".to_string()),
                exit_code: 1,
                ..ContainerStateTerminated::default()
            }),
            ..ContainerState::default()
        });
        assert_eq!(
            pod_containers(&terminated, &empty_maps, &empty_secrets, false)[0].state,
            "Terminated: Error (exit 1)"
        );
    }
}

/// One window can hold several clusters at once, so the engine keeps its state
/// per context: watches, catalogs, namespaces and defaults never mix.
#[cfg(test)]
mod session_tests {
    use super::*;

    fn engine() -> (Engine, std::sync::mpsc::Receiver<AppEvent>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (Engine::new(tx), rx)
    }

    #[tokio::test]
    async fn keeps_a_namespace_per_context() {
        let (mut engine, _rx) = engine();
        engine
            .handle(Command::SetNamespace {
                context: "dev".into(),
                namespace: Some("team-a".into()),
            })
            .await;
        engine
            .handle(Command::SetNamespace {
                context: "prod".into(),
                namespace: Some("team-b".into()),
            })
            .await;
        assert_eq!(
            engine.namespaces.get("dev").cloned().flatten(),
            Some("team-a".to_string())
        );
        assert_eq!(
            engine.namespaces.get("prod").cloned().flatten(),
            Some("team-b".to_string())
        );
    }

    #[tokio::test]
    async fn names_the_cluster_it_cannot_reach() {
        let (mut engine, rx) = engine();
        engine
            .handle(Command::Watch {
                context: "gone".into(),
                target: WatchTarget::Kind(ResourceKind::Pods),
            })
            .await;
        match rx.try_recv().expect("an error event") {
            AppEvent::Error(message) => assert!(message.contains("gone"), "{message}"),
            other => panic!("unexpected event {other:?}"),
        }
        // Nothing was watched, and no client was invented for the context.
        assert!(engine.watches.is_empty());
        assert!(engine.clients.is_empty());
    }

    #[tokio::test]
    async fn stopping_one_watch_leaves_the_others() {
        let (mut engine, _rx) = engine();
        let dev = CancellationToken::new();
        let prod = CancellationToken::new();
        engine.watches.insert("dev".into(), dev.clone());
        engine.watches.insert("prod".into(), prod.clone());
        engine.handle(Command::StopWatch { context: "dev".into() }).await;
        assert!(dev.is_cancelled());
        assert!(!prod.is_cancelled());
    }

    #[tokio::test]
    async fn disconnect_stops_only_that_cluster() {
        let (mut engine, rx) = engine();
        let dev_watch = CancellationToken::new();
        let prod_watch = CancellationToken::new();
        engine.watches.insert("dev".into(), dev_watch.clone());
        engine.watches.insert("prod".into(), prod_watch.clone());
        engine.namespaces.insert("dev".into(), Some("team-a".into()));
        engine.logs.insert(
            1,
            LiveStream {
                context: "dev".into(),
                cancel: CancellationToken::new(),
            },
        );
        engine.forwards.insert(
            2,
            LiveStream {
                context: "prod".into(),
                cancel: CancellationToken::new(),
            },
        );
        let dev_log = engine.logs.get(&1).expect("a log stream").cancel.clone();
        let prod_forward = engine
            .forwards
            .get(&2)
            .expect("a port forward")
            .cancel
            .clone();

        engine
            .handle(Command::Disconnect {
                context: "dev".into(),
            })
            .await;

        // The dropped cluster is gone, token and all.
        assert!(dev_watch.is_cancelled());
        assert!(dev_log.is_cancelled());
        assert!(!engine.namespaces.contains_key("dev"));
        // The cluster next to it is untouched.
        assert!(!prod_watch.is_cancelled());
        assert!(!prod_forward.is_cancelled());
        assert!(engine.watches.contains_key("prod"));
        assert!(engine.forwards.contains_key(&2));
        match rx.try_recv().expect("an event") {
            AppEvent::Disconnected { context } => assert_eq!(context, "dev"),
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[tokio::test]
    async fn disconnecting_twice_is_harmless() {
        let (mut engine, _rx) = engine();
        for _ in 0..2 {
            engine
                .handle(Command::Disconnect {
                    context: "never-opened".into(),
                })
                .await;
        }
        // No client was invented for a context that never connected.
        assert!(engine.clients.is_empty());
        assert!(engine.namespaces.is_empty());
    }
}
