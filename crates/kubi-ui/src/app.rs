use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::{Duration, Instant};

use eframe::egui::{
    self, Align, Align2, Color32, CornerRadius, FontId, Key, Layout, Modifiers, RichText,
    ScrollArea, Sense, Stroke, TextEdit, Vec2,
};
use egui_plot::{Line, Plot, PlotPoints};
use kubi_core::{
    format_age, format_bytes, format_bytes_pair, format_cpu, format_cpu_pair, usage_key, AppEvent,
    ArgoApp, ArgoOverview, ClusterOverview, Command, ContextInfo, CoreHandle, CrTarget, DataEntry,
    OverviewWarning, ResourceKind, ResourceRow, WatchTarget,
};

use crate::theme::{self, tone_color, ACCENT, BAD, FIELD, HOVER, MUTED, OK, SEPARATOR, TEXT, WARN};

const NAV: &[(&str, &[ResourceKind])] = &[
    (
        "Cluster",
        &[
            ResourceKind::Nodes,
            ResourceKind::Namespaces,
            ResourceKind::Events,
        ],
    ),
    (
        "Workloads",
        &[
            ResourceKind::Pods,
            ResourceKind::Deployments,
            ResourceKind::ReplicaSets,
            ResourceKind::StatefulSets,
            ResourceKind::DaemonSets,
            ResourceKind::Jobs,
            ResourceKind::CronJobs,
        ],
    ),
    (
        "Network",
        &[
            ResourceKind::Services,
            ResourceKind::Endpoints,
            ResourceKind::EndpointSlices,
            ResourceKind::Ingresses,
            ResourceKind::IngressClasses,
            ResourceKind::NetworkPolicies,
        ],
    ),
    (
        "Config",
        &[
            ResourceKind::ConfigMaps,
            ResourceKind::Secrets,
            ResourceKind::ResourceQuotas,
            ResourceKind::LimitRanges,
            ResourceKind::HorizontalPodAutoscalers,
            ResourceKind::PodDisruptionBudgets,
        ],
    ),
    (
        "Storage",
        &[
            ResourceKind::PersistentVolumeClaims,
            ResourceKind::PersistentVolumes,
            ResourceKind::StorageClasses,
        ],
    ),
    (
        "Access",
        &[
            ResourceKind::ServiceAccounts,
            ResourceKind::Roles,
            ResourceKind::RoleBindings,
            ResourceKind::ClusterRoles,
            ResourceKind::ClusterRoleBindings,
        ],
    ),
    (
        "Gateway",
        &[
            ResourceKind::GatewayClasses,
            ResourceKind::Gateways,
            ResourceKind::ListenerSets,
            ResourceKind::HttpRoutes,
            ResourceKind::GrpcRoutes,
            ResourceKind::TlsRoutes,
            ResourceKind::TcpRoutes,
            ResourceKind::UdpRoutes,
            ResourceKind::BackendTLSPolicies,
            ResourceKind::ReferenceGrants,
        ],
    ),
];

#[derive(Clone, PartialEq, Eq)]
enum View {
    Overview,
    Argo,
    Resource(ResourceKind),
    Custom(CrTarget),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Home {
    Cluster,
    Argo,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DetailTab {
    Overview,
    Yaml,
    Metrics,
    Data,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Name,
    Namespace,
    Age,
    Status,
    Ready,
    Info,
    Cpu,
    Memory,
    Cell(&'static str),
}

struct Col {
    title: &'static str,
    field: Field,
    colored: bool,
    width: f32,
    min: f32,
}

struct HistPoint {
    t: f64,
    cpu: f64,
    mem: f64,
}

struct Tab {
    view: View,
    rows: Vec<ResourceRow>,
    selected: Option<String>,
    detail_tab: DetailTab,
    yaml: Option<String>,
    yaml_for: Option<String>,
    reveal_secrets: bool,
    waiting: bool,
    filter: String,
    sort: Field,
    sort_asc: bool,
    namespace: Option<String>,
    data: Option<Vec<DataEntry>>,
    data_for: Option<String>,
}

impl Tab {
    fn new(view: View, namespace: Option<String>) -> Self {
        Self {
            view,
            rows: Vec::new(),
            selected: None,
            detail_tab: DetailTab::Overview,
            yaml: None,
            yaml_for: None,
            reveal_secrets: false,
            waiting: true,
            filter: String::new(),
            sort: Field::Name,
            sort_asc: true,
            namespace,
            data: None,
            data_for: None,
        }
    }
}

#[derive(Clone)]
struct PendingDelete {
    target: WatchTarget,
    namespace: String,
    name: String,
    title: String,
}

enum SearchHit {
    View(View),
    Object {
        uid: String,
        name: String,
        namespace: String,
    },
}

pub struct KubiApp {
    core: CoreHandle,
    started: Instant,
    contexts: Vec<ContextInfo>,
    context: Option<String>,
    namespaces: Vec<String>,
    default_namespace: Option<String>,
    last_namespace: Option<String>,
    tabs: Vec<Tab>,
    active: Option<usize>,
    home: Home,
    custom_resources: Vec<CrTarget>,
    error: Option<String>,
    loading_config: bool,
    connecting: bool,
    overview: Option<ClusterOverview>,
    overview_at: Option<Instant>,
    usage: HashMap<String, (f64, f64)>,
    metrics_note: Option<String>,
    history: VecDeque<HistPoint>,
    pending_delete: Option<PendingDelete>,
    pending_select: Option<(WatchTarget, String, String)>,
    create_open: bool,
    create_yaml: String,
    create_error: Option<String>,
    create_busy: bool,
    search_open: bool,
    search_query: String,
    search_cursor: usize,
    search_focus: bool,
}

impl KubiApp {
    fn new() -> Self {
        let core = CoreHandle::spawn();
        core.send(Command::LoadContexts);
        Self {
            core,
            started: Instant::now(),
            contexts: Vec::new(),
            context: None,
            namespaces: Vec::new(),
            default_namespace: None,
            last_namespace: None,
            tabs: Vec::new(),
            active: None,
            home: Home::Cluster,
            custom_resources: Vec::new(),
            error: None,
            loading_config: true,
            connecting: false,
            overview: None,
            overview_at: None,
            usage: HashMap::new(),
            metrics_note: None,
            history: VecDeque::new(),
            pending_delete: None,
            pending_select: None,
            create_open: false,
            create_yaml: String::new(),
            create_error: None,
            create_busy: false,
            search_open: false,
            search_query: String::new(),
            search_cursor: 0,
            search_focus: false,
        }
    }

    fn active_tab(&self) -> Option<&Tab> {
        self.active.and_then(|index| self.tabs.get(index))
    }

    fn active_tab_mut(&mut self) -> Option<&mut Tab> {
        let index = self.active?;
        self.tabs.get_mut(index)
    }

    fn current_view(&self) -> View {
        self.active_tab()
            .map(|tab| tab.view.clone())
            .unwrap_or(View::Overview)
    }

    fn resource_kind(&self) -> Option<ResourceKind> {
        match self.current_view() {
            View::Resource(kind) => Some(kind),
            View::Overview | View::Argo | View::Custom(_) => None,
        }
    }

    fn watch_target(&self) -> Option<WatchTarget> {
        self.active_tab().and_then(|tab| watch_of(&tab.view))
    }

    fn view_title(&self) -> String {
        title_of(&self.current_view())
    }

    fn switch_context(&mut self, name: String) {
        if self.context.as_ref() == Some(&name) {
            return;
        }
        self.context = Some(name.clone());
        self.default_namespace = None;
        self.last_namespace = None;
        self.connecting = true;
        self.custom_resources.clear();
        self.tabs.clear();
        self.active = None;
        self.home = Home::Cluster;
        self.pending_delete = None;
        self.pending_select = None;
        self.create_open = false;
        self.create_error = None;
        self.create_busy = false;
        self.search_open = false;
        self.overview = None;
        self.usage.clear();
        self.history.clear();
        self.metrics_note = None;
        self.core.send(Command::Connect { context: name });
    }

    fn inherited_namespace(&self) -> Option<String> {
        if let Some(tab) = self.active_tab() {
            return tab.namespace.clone();
        }
        if self.tabs.is_empty() {
            return self.default_namespace.clone();
        }
        self.last_namespace.clone()
    }

    fn set_active_namespace(&mut self, namespace: Option<String>) {
        let Some(index) = self.active else {
            return;
        };
        if self.tabs[index].namespace == namespace {
            return;
        }
        self.last_namespace = namespace.clone();
        let tab = &mut self.tabs[index];
        tab.namespace = namespace.clone();
        tab.rows.clear();
        tab.selected = None;
        tab.yaml = None;
        tab.yaml_for = None;
        tab.waiting = true;
        self.usage.clear();
        self.history.clear();
        self.core.send(Command::SetNamespace { namespace });
        self.rewatch();
    }

    fn argo_installed(&self) -> bool {
        self.custom_resources
            .iter()
            .any(|target| target.group == "argoproj.io" && target.kind == "Application")
    }

    fn show_home(&mut self, home: Home) {
        self.home = home;
        self.active = None;
        self.core.send(Command::StopWatch);
        self.core.send(Command::FetchOverview);
        self.overview_at = Some(Instant::now());
    }

    fn open_view(&mut self, view: View) {
        match view {
            View::Overview => {
                if self.active.is_none() && self.home == Home::Cluster {
                    return;
                }
                self.show_home(Home::Cluster);
                return;
            }
            View::Argo => {
                if self.active.is_none() && self.home == Home::Argo {
                    return;
                }
                self.show_home(Home::Argo);
                return;
            }
            View::Resource(_) | View::Custom(_) => {}
        }
        if let Some(index) = self.tabs.iter().position(|tab| tab.view == view) {
            if self.active == Some(index) {
                return;
            }
            self.activate_tab(index);
            return;
        }
        let namespace = self.inherited_namespace();
        self.tabs.push(Tab::new(view, namespace));
        self.activate_tab(self.tabs.len() - 1);
    }

    fn activate_tab(&mut self, index: usize) {
        self.active = Some(index);
        self.last_namespace = self.tabs.get(index).and_then(|tab| tab.namespace.clone());
        self.history.clear();
        self.usage.clear();
        self.metrics_note = None;
        self.rewatch();
    }

    fn close_tab(&mut self, index: usize) {
        if index >= self.tabs.len() {
            return;
        }
        self.tabs.remove(index);
        let Some(active) = self.active else {
            return;
        };
        if active > index {
            self.active = Some(active - 1);
        } else if active == index {
            if self.tabs.is_empty() {
                self.active = None;
                self.core.send(Command::StopWatch);
                self.core.send(Command::FetchOverview);
                self.overview_at = Some(Instant::now());
            } else {
                self.activate_tab(index.min(self.tabs.len() - 1));
            }
        }
    }

    fn rewatch(&mut self) {
        let Some(target) = self.watch_target() else {
            return;
        };
        let namespace = self.active_tab().and_then(|tab| tab.namespace.clone());
        if let Some(tab) = self.active_tab_mut() {
            tab.waiting = true;
        }
        self.core.send(Command::SetNamespace { namespace });
        self.core.send(Command::Watch { target });
    }

    fn refresh(&mut self) {
        self.core.send(Command::RefreshCatalog);
        if self.active.is_none() {
            self.core.send(Command::FetchOverview);
            self.overview_at = Some(Instant::now());
        } else {
            self.rewatch();
        }
    }

    fn select(&mut self, uid: String) {
        if self
            .active_tab()
            .and_then(|tab| tab.selected.clone())
            .as_ref()
            == Some(&uid)
        {
            return;
        }
        if let Some(tab) = self.active_tab_mut() {
            tab.selected = Some(uid);
            tab.yaml = None;
            tab.yaml_for = None;
            tab.data = None;
            tab.data_for = None;
            tab.detail_tab = DetailTab::Overview;
        }
        self.history.clear();
        self.request_yaml();
    }

    fn select_pending(&mut self) {
        let Some((target, namespace, name)) = self.pending_select.clone() else {
            return;
        };
        let Some(index) = self
            .tabs
            .iter()
            .position(|tab| watch_of(&tab.view).as_ref() == Some(&target))
        else {
            return;
        };
        let Some(uid) = self.tabs[index]
            .rows
            .iter()
            .find(|row| row.name == name && row.namespace == namespace)
            .map(|row| row.uid.clone())
        else {
            return;
        };
        self.pending_select = None;
        if self.active != Some(index) {
            self.activate_tab(index);
        }
        self.select(uid);
    }

    fn open_argo_app(&mut self, overview: &ArgoOverview, app: &ArgoApp) {
        self.pending_select = Some((
            WatchTarget::Custom(overview.target.clone()),
            app.namespace.clone(),
            app.name.clone(),
        ));
        self.open_view(View::Custom(overview.target.clone()));
        self.select_pending();
    }

    fn request_yaml(&mut self) {
        let Some(target) = self.watch_target() else {
            return;
        };
        let Some(tab) = self.active_tab() else {
            return;
        };
        let Some(uid) = tab.selected.clone() else {
            return;
        };
        let Some(row) = tab.rows.iter().find(|row| row.uid == uid) else {
            return;
        };
        let namespace = row.namespace.clone();
        let name = row.name.clone();
        let uid = row.uid.clone();
        let reveal_secrets = tab.reveal_secrets;
        self.core.send(Command::FetchYaml {
            target,
            namespace,
            name,
            uid,
            reveal_secrets,
        });
    }

    fn ask_delete_selected(&mut self) {
        let Some(target) = self.watch_target() else {
            return;
        };
        let Some(row) = self.selected_row().cloned() else {
            return;
        };
        self.pending_delete = Some(PendingDelete {
            target,
            namespace: row.namespace,
            name: row.name,
            title: self.view_title(),
        });
    }

    fn restart_selected(&mut self) {
        let Some(kind) = self.resource_kind().filter(|kind| kind.can_restart()) else {
            return;
        };
        let Some(row) = self.selected_row() else {
            return;
        };
        let namespace = row.namespace.clone();
        let name = row.name.clone();
        self.core.send(Command::Restart {
            kind,
            namespace,
            name,
        });
    }

    fn apply_usage(&mut self) {
        let Some(index) = self.active else {
            return;
        };
        let usage = self.usage.clone();
        if let Some(tab) = self.tabs.get_mut(index) {
            kubi_core::apply_usage(&mut tab.rows, &usage);
        }
    }

    fn push_history(&mut self, namespace: &str, name: &str, cpu: f64, mem: f64) {
        let matches = self
            .selected_row()
            .is_some_and(|row| row.namespace == namespace && row.name == name);
        if !matches {
            return;
        }
        let point = HistPoint {
            t: self.started.elapsed().as_secs_f64(),
            cpu,
            mem,
        };
        if let Some(last) = self.history.back_mut() {
            if point.t - last.t < 1.0 {
                *last = point;
                return;
            }
        }
        self.history.push_back(point);
        while self.history.len() > 60 {
            self.history.pop_front();
        }
    }

    fn selected_row(&self) -> Option<&ResourceRow> {
        let tab = self.active_tab()?;
        let uid = tab.selected.as_ref()?;
        tab.rows.iter().find(|row| &row.uid == uid)
    }

    fn handle_events(&mut self) {
        for event in self.core.drain() {
            match event {
                AppEvent::Contexts(contexts) => {
                    self.loading_config = false;
                    self.error = None;
                    self.contexts = contexts;
                    if self.contexts.is_empty() {
                        self.connecting = false;
                        self.custom_resources.clear();
                        continue;
                    }
                    let pick = self
                        .context
                        .clone()
                        .filter(|name| self.contexts.iter().any(|ctx| &ctx.name == name))
                        .or_else(|| {
                            self.contexts
                                .iter()
                                .find(|ctx| ctx.current)
                                .map(|ctx| ctx.name.clone())
                        })
                        .or_else(|| self.contexts.first().map(|ctx| ctx.name.clone()));
                    if let Some(name) = pick {
                        self.context = None;
                        self.switch_context(name);
                    }
                }
                AppEvent::Connected {
                    context,
                    namespaces,
                    default_namespace,
                } => {
                    if self.context.as_ref() != Some(&context) {
                        continue;
                    }
                    self.connecting = false;
                    self.error = None;
                    self.namespaces = namespaces;
                    self.default_namespace = default_namespace;
                    self.core.send(Command::FetchOverview);
                    self.overview_at = Some(Instant::now());
                    self.rewatch();
                }
                AppEvent::Error(message) => {
                    self.connecting = false;
                    self.loading_config = false;
                    if !message.starts_with("discover APIs") {
                        if let Some(tab) = self.active_tab_mut() {
                            tab.waiting = false;
                        }
                    }
                    self.error = Some(message);
                }
                AppEvent::CustomResources { context, targets } => {
                    if self.context.as_deref() == Some(context.as_str()) {
                        self.custom_resources = targets;
                    }
                }
                AppEvent::Rows { target, mut rows } => {
                    let Some(index) = self
                        .tabs
                        .iter()
                        .position(|tab| watch_of(&tab.view).as_ref() == Some(&target))
                    else {
                        continue;
                    };
                    kubi_core::apply_usage(&mut rows, &self.usage);
                    self.tabs[index].rows = rows;
                    self.tabs[index].waiting = false;
                    self.error = None;
                    self.select_pending();
                }
                AppEvent::Usage { kind, samples } => {
                    if self.resource_kind() != Some(kind) {
                        continue;
                    }
                    self.metrics_note = None;
                    for sample in samples {
                        self.push_history(
                            &sample.namespace,
                            &sample.name,
                            sample.cpu_millis,
                            sample.mem_bytes,
                        );
                        self.usage.insert(
                            usage_key(&sample.namespace, &sample.name),
                            (sample.cpu_millis, sample.mem_bytes),
                        );
                    }
                    self.apply_usage();
                }
                AppEvent::MetricsUnavailable { kind, message } => {
                    if self.resource_kind() == Some(kind) {
                        self.metrics_note =
                            Some(format!("Metrics API is not available. {message}"));
                    }
                }
                AppEvent::Yaml { uid, yaml } => {
                    if let Some(tab) = self
                        .tabs
                        .iter_mut()
                        .find(|tab| tab.selected.as_ref() == Some(&uid))
                    {
                        tab.yaml = Some(yaml);
                        tab.yaml_for = Some(uid);
                    }
                }
                AppEvent::ObjectData { uid, entries } => {
                    if let Some(tab) = self
                        .tabs
                        .iter_mut()
                        .find(|tab| tab.selected.as_ref() == Some(&uid))
                    {
                        tab.data = Some(entries);
                        tab.data_for = Some(uid);
                    }
                }
                AppEvent::ApplyResult { error } => {
                    self.create_busy = false;
                    if let Some(error) = error {
                        self.create_error = Some(error);
                    } else {
                        self.create_open = false;
                        self.create_error = None;
                        self.rewatch();
                    }
                }
                AppEvent::Overview(overview) => {
                    if self.context.as_deref() == Some(overview.context.as_str()) {
                        self.overview = Some(*overview);
                    }
                }
                AppEvent::LogStarted { .. }
                | AppEvent::LogLine { .. }
                | AppEvent::LogClosed { .. }
                | AppEvent::PortForwardStarted { .. }
                | AppEvent::PortForwardClosed { .. }
                | AppEvent::ExecStarted { .. }
                | AppEvent::ExecData { .. }
                | AppEvent::ExecClosed { .. } => {}
            }
        }
    }

    fn visible_indices(&self) -> Vec<usize> {
        let Some(tab) = self.active_tab() else {
            return Vec::new();
        };
        let needle = tab.filter.trim().to_ascii_lowercase();
        let mut indices: Vec<usize> = (0..tab.rows.len())
            .filter(|&index| {
                if needle.is_empty() {
                    return true;
                }
                let row = &tab.rows[index];
                row.name.to_ascii_lowercase().contains(&needle)
                    || row.namespace.to_ascii_lowercase().contains(&needle)
                    || row.status.to_ascii_lowercase().contains(&needle)
                    || row.info.to_ascii_lowercase().contains(&needle)
                    || row
                        .cells
                        .values()
                        .any(|value| value.to_ascii_lowercase().contains(&needle))
            })
            .collect();
        let asc = tab.sort_asc;
        let sort = tab.sort;
        indices.sort_by(|&a, &b| compare_rows(&tab.rows[a], &tab.rows[b], sort, asc));
        indices
    }
}

impl eframe::App for KubiApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.handle_events();
        if self.active.is_none()
            && self.context.is_some()
            && self
                .overview_at
                .is_none_or(|at| at.elapsed() >= Duration::from_secs(15))
        {
            self.core.send(Command::FetchOverview);
            self.overview_at = Some(Instant::now());
        }
        ctx.request_repaint_after(Duration::from_millis(100));
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        if !self.search_open && ui.input_mut(|input| input.consume_key(Modifiers::CTRL, Key::A)) {
            self.search_open = true;
            self.search_query.clear();
            self.search_cursor = 0;
            self.search_focus = true;
        }
        self.top_bar(ui);
        self.cluster_hotbar(ui);
        self.side_bar(ui);
        if self.selected_row().is_some() {
            self.detail(ui);
        }
        let home = self.active.is_none();
        egui::CentralPanel::default()
            .frame(
                egui::Frame::central_panel(ui.style())
                    .inner_margin(0)
                    .fill(theme::DOCK),
            )
            .show(ui, |ui| {
                if home && self.home == Home::Argo && self.argo_installed() {
                    self.argo_view(ui);
                } else if home {
                    self.overview_view(ui);
                } else {
                    self.resource_view(ui);
                }
            });
        if self.search_open {
            self.search_modal(ui.ctx());
        }
        if self.pending_delete.is_some() {
            self.delete_modal(ui.ctx());
        }
        if self.create_open {
            self.create_modal(ui.ctx());
        }
    }
}

impl KubiApp {
    fn top_bar(&mut self, ui: &mut egui::Ui) {
        let mut refresh = false;
        let mut dismiss = false;
        egui::Panel::top("top")
            .frame(theme::edge_frame(ui, theme::CHROME).inner_margin(egui::Margin::symmetric(8, 6)))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    let title = self
                        .context
                        .clone()
                        .unwrap_or_else(|| "No cluster".to_string());
                    ui.label(RichText::new(title).size(12.0).color(TEXT));
                    ui.add_space(8.0);
                    if flat_button(ui, "Refresh", TEXT) {
                        refresh = true;
                    }
                });
                if let Some(err) = self.error.clone() {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(err).size(12.0).color(BAD));
                        if flat_button(ui, "×", MUTED) {
                            dismiss = true;
                        }
                    });
                }
            });
        if refresh {
            self.refresh();
        }
        if dismiss {
            self.error = None;
        }
    }

    fn open_kubeconfig(&mut self) {
        if let Some(path) = rfd::FileDialog::new()
            .set_title("Open kubeconfig")
            .pick_file()
        {
            self.context = None;
            self.loading_config = true;
            self.core.send(Command::SetKubeconfig { path });
        }
    }

    fn cluster_hotbar(&mut self, ui: &mut egui::Ui) {
        let contexts = self.contexts.clone();
        let active = self.context.clone();
        let mut picked = None;
        let mut open_config = false;
        egui::Panel::left("cluster-hotbar")
            .exact_size(56.0)
            .resizable(false)
            .frame(theme::edge_frame(ui, theme::CHROME))
            .show(ui, |ui| {
                ui.allocate_ui_with_layout(
                    Vec2::new(ui.available_width(), ui.available_height()),
                    Layout::bottom_up(Align::Center),
                    |ui| {
                        ui.add_space(8.0);
                        if ui
                            .add_sized(Vec2::splat(28.0), egui::Button::new("+"))
                            .on_hover_text("Open kubeconfig")
                            .clicked()
                        {
                            open_config = true;
                        }
                        ui.add_space(4.0);
                        ScrollArea::vertical()
                            .id_salt("cluster-hotbar")
                            .show(ui, |ui| {
                                ui.add_space(8.0);
                                ui.vertical_centered(|ui| {
                                    for ctx in &contexts {
                                        let is_active =
                                            active.as_deref() == Some(ctx.name.as_str());
                                        if cluster_chip(ui, ctx, is_active) {
                                            picked = Some(ctx.name.clone());
                                        }
                                        ui.add_space(6.0);
                                    }
                                });
                            });
                    },
                );
            });
        if let Some(name) = picked {
            self.switch_context(name);
        }
        if open_config {
            self.open_kubeconfig();
        }
    }

    fn namespace_combo(&mut self, ui: &mut egui::Ui) {
        let namespaces = self.namespaces.clone();
        let current = self.active_tab().and_then(|tab| tab.namespace.clone());
        let label = current
            .clone()
            .unwrap_or_else(|| "All namespaces".to_string());
        let prefix_id = ui.id().with(("ns-type", self.active));
        let mut prefix: String = ui.data(|data| data.get_temp(prefix_id)).unwrap_or_default();
        let mut picked: Option<Option<String>> = None;
        let response = egui::ComboBox::from_id_salt(("tab-namespace", self.active))
            .width(180.0)
            .selected_text(label)
            .show_ui(ui, |ui| {
                let mut typed = String::new();
                let mut backspace = false;
                let mut enter = false;
                ui.input_mut(|input| {
                    input.events.retain(|event| match event {
                        egui::Event::Text(text) if !text.chars().any(char::is_control) => {
                            typed.push_str(text);
                            false
                        }
                        egui::Event::Key {
                            key: Key::Backspace,
                            pressed: true,
                            modifiers,
                            ..
                        } if !modifiers.command && !modifiers.ctrl => {
                            backspace = true;
                            false
                        }
                        egui::Event::Key {
                            key: Key::Enter,
                            pressed: true,
                            modifiers,
                            ..
                        } if !modifiers.command && !modifiers.ctrl && !modifiers.alt => {
                            enter = true;
                            false
                        }
                        _ => true,
                    });
                });
                if backspace {
                    prefix.pop();
                }
                prefix.push_str(&typed);
                ui.data_mut(|data| data.insert_temp(prefix_id, prefix.clone()));
                let needle = prefix.to_ascii_lowercase();
                let mut shown: Vec<Option<String>> = Vec::new();
                if needle.is_empty() {
                    shown.push(None);
                }
                for namespace in &namespaces {
                    if needle.is_empty() || namespace.to_ascii_lowercase().starts_with(&needle) {
                        shown.push(Some(namespace.clone()));
                    }
                }
                if enter {
                    if let Some(item) = shown.first() {
                        picked = Some(item.clone());
                        egui::Popup::close_all(ui.ctx());
                    }
                }
                if shown.is_empty() {
                    ui.label(RichText::new("No namespaces").size(12.0).color(MUTED));
                }
                for item in &shown {
                    let text = item.clone().unwrap_or_else(|| "All namespaces".to_string());
                    if ui.selectable_label(current == *item, text).clicked() {
                        picked = Some(item.clone());
                    }
                }
            });
        if response.inner.is_none() {
            ui.data_mut(|data| data.remove_temp::<String>(prefix_id));
        }
        if let Some(namespace) = picked {
            self.set_active_namespace(namespace);
        }
    }

    fn side_bar(&mut self, ui: &mut egui::Ui) {
        let mut next = None;
        let view = self.current_view();
        let groups = cr_groups(&self.custom_resources);
        let gateway = installed_gateway(&self.custom_resources);
        egui::Panel::left("nav")
            .exact_size(236.0)
            .resizable(false)
            .frame(theme::edge_frame(ui, theme::DOCK))
            .show(ui, |ui| {
                ScrollArea::vertical().id_salt("nav").show(ui, |ui| {
                    ui.add_space(6.0);
                    if resource_row(
                        ui,
                        "Overview",
                        self.active.is_none() && self.home == Home::Cluster,
                        0.0,
                    ) {
                        next = Some(View::Overview);
                    }
                    if self.argo_installed()
                        && resource_row(
                            ui,
                            "Argo CD",
                            self.active.is_none() && self.home == Home::Argo,
                            0.0,
                        )
                    {
                        next = Some(View::Argo);
                    }
                    ui.add_space(4.0);
                    for (title, kinds) in NAV {
                        let shown: Vec<ResourceKind> = if *title == "Gateway" {
                            if gateway.is_empty() {
                                continue;
                            }
                            gateway.clone()
                        } else {
                            kinds.to_vec()
                        };
                        let salt = format!("nav-tree-v3-{title}");
                        let open = section_open(ui, &salt);
                        if group_header(ui, title, shown.len(), open, 0.0) {
                            set_section_open(ui, &salt, !open);
                        }
                        if open {
                            for kind in shown {
                                if resource_row(
                                    ui,
                                    kind.title(),
                                    view == View::Resource(kind),
                                    12.0,
                                ) {
                                    next = Some(View::Resource(kind));
                                }
                            }
                        }
                    }
                    let cr_salt = "custom-resources-v3";
                    let cr_open = section_open(ui, cr_salt);
                    let cr_count = 1 + groups
                        .iter()
                        .map(|(_, targets)| targets.len())
                        .sum::<usize>();
                    if group_header(ui, "Custom Resources", cr_count, cr_open, 0.0) {
                        set_section_open(ui, cr_salt, !cr_open);
                    }
                    if cr_open {
                        if resource_row(
                            ui,
                            "Definitions",
                            view == View::Resource(ResourceKind::CustomResourceDefinitions),
                            12.0,
                        ) {
                            next = Some(View::Resource(ResourceKind::CustomResourceDefinitions));
                        }
                        for (group, targets) in &groups {
                            let salt = format!("cr-tree-v3-{group}");
                            let open = section_open(ui, &salt);
                            if group_header(ui, group, targets.len(), open, 12.0) {
                                set_section_open(ui, &salt, !open);
                            }
                            if open {
                                for target in targets {
                                    if resource_row(
                                        ui,
                                        &target.kind,
                                        view == View::Custom(target.clone()),
                                        24.0,
                                    ) {
                                        next = Some(View::Custom(target.clone()));
                                    }
                                }
                            }
                        }
                    }
                    ui.add_space(8.0);
                });
            });
        if let Some(view) = next {
            self.open_view(view);
        }
    }

    fn overview_view(&mut self, ui: &mut egui::Ui) {
        let overview = self.overview.clone();
        let loading = self.loading_config;
        let connecting = self.connecting;
        let contexts_empty = self.contexts.is_empty();
        let context = self.context.clone();
        let cluster = context.as_ref().and_then(|name| {
            self.contexts
                .iter()
                .find(|ctx| &ctx.name == name)
                .map(|ctx| ctx.cluster.clone())
        });
        ScrollArea::vertical()
            .id_salt("cluster-overview")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.add_space(16.0);
                ui.horizontal(|ui| {
                    ui.add_space(16.0);
                    ui.vertical(|ui| {
                        ui.set_max_width(760.0);
                        ui.label(RichText::new("Overview").size(18.0).color(TEXT));
                        if loading {
                            ui.horizontal(|ui| {
                                ui.spinner();
                                ui.label("Reading kubeconfig…");
                            });
                            return;
                        }
                        if contexts_empty {
                            ui.label(
                                "No contexts in kubeconfig. Open a kubeconfig file, or create ~/.kube/config.",
                            );
                            return;
                        }
                        if connecting {
                            ui.horizontal(|ui| {
                                ui.spinner();
                                ui.label("Connecting…");
                            });
                        }
                        let Some(context) = context.clone() else {
                            ui.label("Select a cluster.");
                            return;
                        };
                        let cluster = cluster.clone().unwrap_or_default();
                        ui.label(RichText::new(format!("{context}  ·  {cluster}")).color(MUTED));
                        ui.add_space(12.0);
                        let Some(overview) = overview.as_ref() else {
                            if !connecting {
                                ui.horizontal(|ui| {
                                    ui.spinner();
                                    ui.label("Loading cluster summary…");
                                });
                            }
                            return;
                        };
                        let warnings = overview
                            .warning_events
                            .map(|count| count.to_string())
                            .unwrap_or_else(|| "-".to_string());
                        section_card(ui, "", true, |ui| {
                            ui.horizontal_wrapped(|ui| {
                                stat_card(
                                    ui,
                                    "Nodes ready",
                                    &format!("{}/{}", overview.nodes_ready, overview.nodes_total),
                                    OK,
                                );
                                stat_card(ui, "Pods", &overview.pods.to_string(), ACCENT);
                                stat_card(ui, "Namespaces", &overview.namespaces.to_string(), TEXT);
                                stat_card(
                                    ui,
                                    "Warnings",
                                    &warnings,
                                    if overview.warning_events.unwrap_or(0) > 0 {
                                        BAD
                                    } else {
                                        MUTED
                                    },
                                );
                            });
                            if let Some(note) = &overview.note {
                                ui.add_space(8.0);
                                ui.label(RichText::new(note).color(MUTED));
                            }
                        });
                        section_card(ui, "Pods", true, |ui| {
                            share_bar(
                                ui,
                                "",
                                &[
                                    ("Running", overview.pods_running, OK),
                                    ("Pending", overview.pods_pending, WARN),
                                    ("Failed", overview.pods_failed, BAD),
                                    ("Succeeded", overview.pods_succeeded, MUTED),
                                    ("Unknown", overview.pods_unknown, TEXT),
                                ],
                            );
                        });
                        let has_cpu = overview.cpu_millis.is_some()
                            && overview.cpu_allocatable_millis.is_some();
                        let has_mem = overview.mem_bytes.is_some()
                            && overview.mem_allocatable_bytes.is_some();
                        if has_cpu || has_mem {
                            section_card(ui, "Capacity", true, |ui| {
                                if let (Some(cpu), Some(cpu_cap)) =
                                    (overview.cpu_millis, overview.cpu_allocatable_millis)
                                {
                                    usage_bar(ui, "CPU", cpu, cpu_cap, format_cpu);
                                }
                                if let (Some(mem), Some(mem_cap)) =
                                    (overview.mem_bytes, overview.mem_allocatable_bytes)
                                {
                                    if has_cpu {
                                        ui.add_space(8.0);
                                    }
                                    usage_bar(ui, "Memory", mem, mem_cap, format_bytes);
                                }
                            });
                        }
                        if !overview.warnings.is_empty() {
                            section_card(ui, "Recent warnings", true, |ui| {
                                for warning in &overview.warnings {
                                    warning_line(ui, warning);
                                }
                            });
                        }
                        ui.add_space(4.0);
                    });
                });
            });
    }

    fn argo_view(&mut self, ui: &mut egui::Ui) {
        let argo = self.overview.as_ref().and_then(|item| item.argo.clone());
        let waiting = self.overview.is_none() || self.connecting;
        let mut open_app = None;
        ScrollArea::vertical()
            .id_salt("argo-overview")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.add_space(16.0);
                ui.horizontal(|ui| {
                    ui.add_space(16.0);
                    ui.vertical(|ui| {
                        ui.set_max_width(760.0);
                        ui.label(RichText::new("Argo CD").size(18.0).color(TEXT));
                        ui.add_space(12.0);
                        let Some(argo) = argo.as_ref() else {
                            if waiting {
                                ui.horizontal(|ui| {
                                    ui.spinner();
                                    ui.label("Loading applications…");
                                });
                            } else {
                                ui.label("Argo CD applications are not available.");
                            }
                            return;
                        };
                        if let Some(note) = &argo.note {
                            ui.label(RichText::new(note).size(12.0).color(BAD));
                            ui.add_space(12.0);
                        }
                        let (health, sync) = argo_counts(argo);
                        let total = argo.apps.len() as u32;
                        ui.horizontal_wrapped(|ui| {
                            ui.spacing_mut().item_spacing.x = 12.0;
                            section_card(ui, "Health", false, |ui| {
                                ui.set_min_width(320.0);
                                ui.vertical_centered(|ui| {
                                    progress_ring(ui, health[0], total, OK);
                                });
                                status_legend(
                                    ui,
                                    &[
                                        ("Degraded", health[1], BAD),
                                        ("Progressing", health[2], WARN),
                                        ("Missing", health[3], BAD),
                                        ("Unknown", health[4], MUTED),
                                    ],
                                );
                            });
                            section_card(ui, "Sync", false, |ui| {
                                ui.set_min_width(320.0);
                                ui.vertical_centered(|ui| {
                                    progress_ring(ui, sync[0], total, OK);
                                });
                                status_legend(
                                    ui,
                                    &[("OutOfSync", sync[1], WARN), ("Unknown", sync[2], MUTED)],
                                );
                            });
                        });
                        section_card(ui, "Applications", true, |ui| {
                            if argo.apps.is_empty() {
                                ui.label(RichText::new("No applications").color(MUTED));
                                return;
                            }
                            for app in &argo.apps {
                                if app_row(ui, app) {
                                    open_app = Some(app.clone());
                                }
                            }
                        });
                        ui.add_space(4.0);
                    });
                });
            });
        if let (Some(app), Some(argo)) = (open_app, argo.as_ref()) {
            self.open_argo_app(argo, &app);
        }
    }

    fn resource_view(&mut self, ui: &mut egui::Ui) {
        self.tab_strip(ui);
        self.toolbar(ui);
        let empty = self.active_tab().is_none_or(|tab| tab.rows.is_empty());
        let waiting = self.active_tab().is_some_and(|tab| tab.waiting);
        if self.connecting || waiting && empty {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.add_space(8.0);
                ui.spinner();
                ui.label(if self.connecting {
                    "Connecting…"
                } else {
                    "Loading…"
                });
            });
            return;
        }
        if empty {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.add_space(8.0);
                ui.label("No objects.");
            });
            return;
        }
        ui.spacing_mut().item_spacing.x = 0.0;
        self.table(ui);
    }

    fn tab_strip(&mut self, ui: &mut egui::Ui) {
        let mut activate = None;
        let mut close = None;
        let active = self.active;
        let titles: Vec<String> = self.tabs.iter().map(|tab| title_of(&tab.view)).collect();
        egui::Frame::new()
            .fill(theme::TAB_STRIP)
            .inner_margin(egui::Margin::symmetric(4, 0))
            .show(ui, |ui| {
                ScrollArea::horizontal()
                    .id_salt("resource-tabs")
                    .max_height(32.0)
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 0.0;
                            ui.set_min_height(32.0);
                            for (index, title) in titles.iter().enumerate() {
                                let is_active = active == Some(index);
                                let text_width = (title.len() as f32).mul_add(7.0, 16.0).max(48.0);
                                let (text_rect, text_response) = ui.allocate_exact_size(
                                    Vec2::new(text_width, 32.0),
                                    Sense::click(),
                                );
                                let (close_rect, close_response) =
                                    ui.allocate_exact_size(Vec2::new(20.0, 32.0), Sense::click());
                                let rect = text_rect.union(close_rect);
                                if is_active {
                                    ui.painter().rect_filled(rect, 0, HOVER);
                                    ui.painter().hline(
                                        rect.x_range(),
                                        rect.bottom() - 1.0,
                                        Stroke::new(2.0, ACCENT),
                                    );
                                } else if text_response.hovered() || close_response.hovered() {
                                    ui.painter().rect_filled(
                                        rect,
                                        0,
                                        Color32::from_rgb(54, 54, 54),
                                    );
                                }
                                ui.painter().text(
                                    text_rect.left_center() + Vec2::new(10.0, 0.0),
                                    Align2::LEFT_CENTER,
                                    title,
                                    FontId::proportional(12.0),
                                    if is_active { TEXT } else { MUTED },
                                );
                                ui.painter().text(
                                    close_rect.center(),
                                    Align2::CENTER_CENTER,
                                    "×",
                                    FontId::proportional(14.0),
                                    MUTED,
                                );
                                if close_response.clicked() {
                                    close = Some(index);
                                } else if text_response.clicked() {
                                    activate = Some(index);
                                }
                            }
                        });
                    });
            });
        if let Some(index) = close {
            self.close_tab(index);
        } else if let Some(index) = activate {
            self.activate_tab(index);
        }
    }

    fn toolbar(&mut self, ui: &mut egui::Ui) {
        let mut filter = self
            .active_tab()
            .map(|tab| tab.filter.clone())
            .unwrap_or_default();
        let count = self.visible_indices().len();
        let can_restart = self.resource_kind().is_some_and(ResourceKind::can_restart)
            && self.selected_row().is_some();
        let can_delete = self.selected_row().is_some();
        let mut restart = false;
        let mut delete = false;
        let mut create = false;
        egui::Frame::new()
            .fill(theme::CHROME)
            .inner_margin(egui::Margin::symmetric(8, 4))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Namespace").size(12.0).color(MUTED));
                    self.namespace_combo(ui);
                    ui.add_space(8.0);
                    let changed = ui
                        .add(
                            TextEdit::singleline(&mut filter)
                                .hint_text("Filter")
                                .desired_width(180.0),
                        )
                        .changed();
                    let _ = changed;
                    ui.label(RichText::new(count.to_string()).size(12.0).color(MUTED));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if flat_button(ui, "Create", TEXT) {
                            create = true;
                        }
                        if can_delete && glyph_button(ui, "Delete", BAD, paint_trash) {
                            delete = true;
                        }
                        if can_restart && glyph_button(ui, "Restart", TEXT, paint_restart) {
                            restart = true;
                        }
                    });
                });
            });
        if let Some(tab) = self.active_tab_mut() {
            tab.filter = filter;
        }
        if restart {
            self.restart_selected();
        }
        if delete {
            self.ask_delete_selected();
        }
        if create {
            self.open_create();
        }
    }

    fn open_create(&mut self) {
        let namespace = self.active_tab().and_then(|tab| tab.namespace.clone());
        let view = self.current_view();
        self.create_yaml = object_template(&view, namespace.as_deref());
        self.create_error = None;
        self.create_busy = false;
        self.create_open = true;
    }

    fn table(&mut self, ui: &mut egui::Ui) {
        let Some(view) = self.active_tab().map(|tab| tab.view.clone()) else {
            return;
        };
        let cols = columns_for(&view);
        let indices = self.visible_indices();
        let rows = self
            .active_tab()
            .map(|tab| tab.rows.clone())
            .unwrap_or_default();
        let selected = self.active_tab().and_then(|tab| tab.selected.clone());
        let sort = self.active_tab().map(|tab| tab.sort).unwrap_or(Field::Name);
        let asc = self.active_tab().is_none_or(|tab| tab.sort_asc);
        let widths = column_widths(&cols, ui.available_width());
        let content_w: f32 = widths.iter().sum();
        let header_h = 28.0;
        let (header_rect, _) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), header_h), Sense::hover());
        let row_h = 28.0;
        let total_h = (indices.len() as f32 * row_h).max(row_h);
        let tab_index = self.active.unwrap_or(0);
        let scrolled = ScrollArea::both()
            .id_salt(("object-table", tab_index))
            .auto_shrink([false, false])
            .show_viewport(ui, |ui, viewport| {
                let origin = ui.max_rect().min;
                ui.set_min_size(Vec2::new(content_w, total_h));
                let mut pick = None;
                if indices.is_empty() {
                    ui.painter().text(
                        origin + Vec2::new(12.0, 16.0),
                        Align2::LEFT_CENTER,
                        "No matching objects",
                        FontId::proportional(12.0),
                        MUTED,
                    );
                    return pick;
                }
                let start = (viewport.min.y / row_h).floor().max(0.0) as usize;
                let end = ((viewport.max.y / row_h).ceil() as usize)
                    .saturating_add(1)
                    .min(indices.len());
                for i in start..end {
                    let item = &rows[indices[i]];
                    let rect = egui::Rect::from_min_size(
                        origin + Vec2::new(0.0, i as f32 * row_h),
                        Vec2::new(content_w, row_h),
                    );
                    let response = ui.interact(rect, ui.id().with(&item.uid), Sense::click());
                    let is_selected = selected.as_ref() == Some(&item.uid);
                    if response.hovered() {
                        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                    }
                    let fill = if is_selected {
                        theme::ROW_SELECTED
                    } else if response.hovered() {
                        HOVER
                    } else {
                        Color32::TRANSPARENT
                    };
                    if fill != Color32::TRANSPARENT {
                        ui.painter().rect_filled(rect, CornerRadius::ZERO, fill);
                    }
                    paint_table_row(ui.painter(), rect, &cols, &widths, item);
                    if response.clicked() {
                        pick = Some(item.uid.clone());
                    }
                }
                pick
            });
        let header_view =
            egui::Rect::from_x_y_ranges(scrolled.inner_rect.x_range(), header_rect.y_range());
        let header_click = paint_table_header(
            ui,
            header_view,
            &cols,
            &widths,
            scrolled.state.offset.x,
            sort,
            asc,
        );
        if let Some(column) = header_click {
            if let Some(tab) = self.active_tab_mut() {
                if tab.sort == column {
                    tab.sort_asc = !tab.sort_asc;
                } else {
                    tab.sort = column;
                    tab.sort_asc = true;
                }
            }
        }
        if let Some(uid) = scrolled.inner {
            self.select(uid);
        }
    }

    fn detail(&mut self, ui: &mut egui::Ui) {
        let title = self.view_title();
        let show_metrics = self
            .resource_kind()
            .is_some_and(ResourceKind::supports_metrics);
        let is_secret = self.resource_kind().is_some_and(ResourceKind::is_secret);
        let has_values = self.resource_kind().is_some_and(ResourceKind::has_values);
        let row = self.selected_row().cloned();
        let Some(row) = row else {
            return;
        };
        let can_restart = self.resource_kind().is_some_and(ResourceKind::can_restart);
        let mut reveal_changed = false;
        let mut reveal = self.active_tab().is_some_and(|tab| tab.reveal_secrets);
        let mut close = false;
        let mut ask_delete = false;
        let mut do_restart = false;
        let mut detail_tab = self
            .active_tab()
            .map(|tab| tab.detail_tab)
            .unwrap_or(DetailTab::Overview);
        let yaml = self.active_tab().and_then(|tab| tab.yaml.clone());
        let yaml_ready = self
            .active_tab()
            .is_some_and(|tab| tab.yaml_for.as_ref() == tab.selected.as_ref());
        egui::Panel::right("detail")
            .default_size(440.0)
            .max_size(480.0)
            .resizable(true)
            .frame(theme::edge_frame(ui, theme::DOCK))
            .show(ui, |ui| {
                egui::Frame::new()
                    .inner_margin(egui::Margin::symmetric(8, 6))
                    .show(ui, |ui| {
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if flat_button(ui, "×", MUTED) {
                                close = true;
                            }
                            if glyph_button(ui, "Delete", BAD, paint_trash) {
                                ask_delete = true;
                            }
                            if can_restart && glyph_button(ui, "Restart", TEXT, paint_restart) {
                                do_restart = true;
                            }
                            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                                wrapping_label(ui, RichText::new(&row.name).strong().size(13.0));
                            });
                        });
                        let namespace = if row.namespace.is_empty() {
                            "-".to_string()
                        } else {
                            row.namespace.clone()
                        };
                        wrapping_label(
                            ui,
                            RichText::new(format!("{title}  ·  {namespace}"))
                                .size(12.0)
                                .color(MUTED),
                        );
                    });
                egui::Frame::new()
                    .fill(theme::TAB_STRIP)
                    .inner_margin(egui::Margin::symmetric(8, 4))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            if text_tab(ui, "Overview", detail_tab == DetailTab::Overview) {
                                detail_tab = DetailTab::Overview;
                            }
                            if text_tab(ui, "YAML", detail_tab == DetailTab::Yaml) {
                                detail_tab = DetailTab::Yaml;
                            }
                            if show_metrics
                                && text_tab(ui, "Metrics", detail_tab == DetailTab::Metrics)
                            {
                                detail_tab = DetailTab::Metrics;
                            }
                            if has_values && text_tab(ui, "Data", detail_tab == DetailTab::Data) {
                                detail_tab = DetailTab::Data;
                            }
                        });
                    });
                ui.painter().hline(
                    ui.available_rect_before_wrap().x_range(),
                    ui.cursor().top(),
                    Stroke::new(1.0, SEPARATOR),
                );
                ui.add_space(6.0);
                match detail_tab {
                    DetailTab::Overview => overview_tab(ui, &row),
                    DetailTab::Data => {
                        if is_secret && ui.checkbox(&mut reveal, "Show secret values").changed() {
                            reveal_changed = true;
                        }
                        let entries = self.active_tab().and_then(|tab| tab.data.clone());
                        let ready = self
                            .active_tab()
                            .is_some_and(|tab| tab.data_for.as_ref() == tab.selected.as_ref());
                        data_tab(ui, entries.as_deref(), ready);
                    }
                    DetailTab::Yaml => {
                        if is_secret && ui.checkbox(&mut reveal, "Show secret values").changed() {
                            reveal_changed = true;
                        }
                        if yaml_ready {
                            if let Some(yaml) = &yaml {
                                if flat_button(ui, "Copy", TEXT) {
                                    ui.ctx().copy_text(yaml.clone());
                                }
                                show_yaml(ui, yaml);
                            }
                        } else {
                            ui.horizontal(|ui| {
                                ui.spinner();
                                ui.label("Loading YAML…");
                            });
                        }
                    }
                    DetailTab::Metrics => self.metrics_tab(ui, &row),
                }
            });
        if let Some(tab) = self.active_tab_mut() {
            tab.detail_tab = detail_tab;
            if reveal_changed {
                tab.reveal_secrets = reveal;
                tab.yaml = None;
                tab.yaml_for = None;
                tab.data = None;
                tab.data_for = None;
            }
            if close {
                tab.selected = None;
                tab.yaml = None;
                tab.yaml_for = None;
            }
        }
        if reveal_changed {
            self.request_yaml();
        }
        if ask_delete {
            self.ask_delete_selected();
        }
        if do_restart {
            self.restart_selected();
        }
    }

    fn metrics_tab(&self, ui: &mut egui::Ui, row: &ResourceRow) {
        if let Some(note) = &self.metrics_note {
            ui.label(note);
            ui.add_space(8.0);
        }
        ui.label(format!(
            "CPU  {}    Memory  {}",
            format_cpu_pair(row.cpu_millis, row.cpu_request_millis),
            format_bytes_pair(row.mem_bytes, row.mem_request_bytes)
        ));
        if self.history.is_empty() {
            ui.label(RichText::new("Waiting for metrics samples…").color(MUTED));
            return;
        }
        let cpu: Vec<[f64; 2]> = self
            .history
            .iter()
            .map(|point| [point.t, point.cpu])
            .collect();
        let mem: Vec<[f64; 2]> = self
            .history
            .iter()
            .map(|point| [point.t, point.mem / (1024.0 * 1024.0)])
            .collect();
        ui.label(RichText::new("CPU (millicores)").color(MUTED));
        Plot::new("cpu")
            .height(150.0)
            .allow_scroll(false)
            .allow_drag(false)
            .show(ui, |plot_ui| {
                plot_ui.line(Line::new("CPU", PlotPoints::new(cpu)).color(ACCENT));
            });
        ui.label(RichText::new("Memory (MiB)").color(MUTED));
        Plot::new("mem")
            .height(150.0)
            .allow_scroll(false)
            .allow_drag(false)
            .show(ui, |plot_ui| {
                plot_ui.line(Line::new("Memory", PlotPoints::new(mem)).color(OK));
            });
        ui.label(
            RichText::new(
                "CPU is usage versus requests. For nodes the second number is allocatable.",
            )
            .small()
            .color(MUTED),
        );
    }

    fn search_modal(&mut self, ctx: &egui::Context) {
        let mut query = self.search_query.clone();
        let mut focus = self.search_focus;
        let hits = self.search_hits(&query);
        if self.search_cursor >= hits.len() {
            self.search_cursor = hits.len().saturating_sub(1);
        }
        let cursor = self.search_cursor;
        let mut chosen = None;
        let mut move_cursor = None;
        let response = egui::Modal::new(egui::Id::new("spotlight")).show(ctx, |ui| {
            ui.set_min_width(480.0);
            ui.set_max_width(480.0);
            let edit = ui.add(
                TextEdit::singleline(&mut query)
                    .hint_text("Search resources")
                    .desired_width(460.0),
            );
            if focus {
                edit.request_focus();
                focus = false;
            }
            if edit.changed() {
                move_cursor = Some(0);
            }
            ui.input_mut(|input| {
                if input.consume_key(Modifiers::NONE, Key::ArrowDown) && !hits.is_empty() {
                    move_cursor = Some((cursor + 1).min(hits.len() - 1));
                }
                if input.consume_key(Modifiers::NONE, Key::ArrowUp) {
                    move_cursor = Some(cursor.saturating_sub(1));
                }
                if input.consume_key(Modifiers::NONE, Key::Enter) && !hits.is_empty() {
                    chosen = Some(cursor);
                }
            });
            ui.add_space(4.0);
            if hits.is_empty() {
                ui.label(RichText::new("Nothing matches").color(MUTED));
            } else {
                ScrollArea::vertical().max_height(260.0).show(ui, |ui| {
                    for (index, hit) in hits.iter().enumerate() {
                        let (title, subtitle) = hit_label(hit);
                        let (rect, response) =
                            ui.allocate_exact_size(Vec2::new(460.0, 24.0), Sense::click());
                        if index == cursor || response.hovered() {
                            ui.painter().rect_filled(rect, 0, HOVER);
                        }
                        ui.painter().text(
                            rect.left_center() + Vec2::new(8.0, 0.0),
                            Align2::LEFT_CENTER,
                            title,
                            FontId::proportional(12.0),
                            TEXT,
                        );
                        if !subtitle.is_empty() {
                            ui.painter().text(
                                rect.right_center() - Vec2::new(8.0, 0.0),
                                Align2::RIGHT_CENTER,
                                subtitle,
                                FontId::proportional(12.0),
                                MUTED,
                            );
                        }
                        if response.clicked() {
                            chosen = Some(index);
                        }
                    }
                });
            }
        });
        self.search_query = query;
        self.search_focus = focus;
        if let Some(cursor) = move_cursor {
            self.search_cursor = cursor;
        }
        if response.should_close() {
            self.search_open = false;
            return;
        }
        if let Some(index) = chosen {
            if let Some(hit) = self.search_hits(&self.search_query).get(index) {
                let hit = match hit {
                    SearchHit::View(view) => SearchHit::View(view.clone()),
                    SearchHit::Object {
                        uid,
                        name,
                        namespace,
                    } => SearchHit::Object {
                        uid: uid.clone(),
                        name: name.clone(),
                        namespace: namespace.clone(),
                    },
                };
                self.apply_hit(hit);
            }
        }
    }

    fn search_hits(&self, query: &str) -> Vec<SearchHit> {
        let needle = query.trim().to_ascii_lowercase();
        let mut hits = Vec::new();
        if needle.is_empty() || "overview".contains(&needle) {
            hits.push(SearchHit::View(View::Overview));
        }
        if self.argo_installed()
            && (needle.is_empty() || "argo cd".contains(&needle) || "argocd".contains(&needle))
        {
            hits.push(SearchHit::View(View::Argo));
        }
        for (title, kinds) in NAV {
            let kinds = if *title == "Gateway" {
                installed_gateway(&self.custom_resources)
            } else {
                kinds.to_vec()
            };
            for kind in kinds {
                if needle.is_empty()
                    || kind.title().to_ascii_lowercase().contains(&needle)
                    || title.to_ascii_lowercase().contains(&needle)
                {
                    hits.push(SearchHit::View(View::Resource(kind)));
                }
            }
        }
        if needle.is_empty()
            || "definitions".contains(&needle)
            || "customresourcedefinitions".contains(&needle)
        {
            hits.push(SearchHit::View(View::Resource(
                ResourceKind::CustomResourceDefinitions,
            )));
        }
        for target in &self.custom_resources {
            if target.group == "gateway.networking.k8s.io" {
                continue;
            }
            if needle.is_empty()
                || target.kind.to_ascii_lowercase().contains(&needle)
                || target.group.to_ascii_lowercase().contains(&needle)
            {
                hits.push(SearchHit::View(View::Custom(target.clone())));
            }
        }
        if !needle.is_empty() {
            if let Some(tab) = self.active_tab() {
                for row in &tab.rows {
                    if row.name.to_ascii_lowercase().contains(&needle)
                        || row.namespace.to_ascii_lowercase().contains(&needle)
                    {
                        hits.push(SearchHit::Object {
                            uid: row.uid.clone(),
                            name: row.name.clone(),
                            namespace: row.namespace.clone(),
                        });
                    }
                }
            }
        }
        hits.truncate(80);
        hits
    }

    fn apply_hit(&mut self, hit: SearchHit) {
        self.search_open = false;
        match hit {
            SearchHit::View(view) => self.open_view(view),
            SearchHit::Object { uid, .. } => self.select(uid),
        }
    }

    fn create_modal(&mut self, ctx: &egui::Context) {
        let mut yaml = self.create_yaml.clone();
        let mut cancel = false;
        let mut apply = false;
        let busy = self.create_busy;
        let error = self.create_error.clone();
        let response = egui::Modal::new(egui::Id::new("create-object")).show(ctx, |ui| {
            ui.set_min_width(560.0);
            ui.label(RichText::new("Create").size(13.0).color(TEXT));
            ui.add_space(6.0);
            ui.add(
                TextEdit::multiline(&mut yaml)
                    .code_editor()
                    .desired_width(f32::INFINITY)
                    .desired_rows(16),
            );
            if let Some(error) = &error {
                ui.add_space(6.0);
                ui.label(RichText::new(error).size(12.0).color(BAD));
            }
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if flat_button(ui, "Cancel", TEXT) {
                    cancel = true;
                }
                if !busy && flat_button(ui, "Apply", ACCENT) {
                    apply = true;
                }
                if busy {
                    ui.spinner();
                }
            });
        });
        self.create_yaml = yaml;
        if cancel || response.should_close() {
            self.create_open = false;
            self.create_busy = false;
        } else if apply {
            self.create_busy = true;
            self.create_error = None;
            let namespace = self.active_tab().and_then(|tab| tab.namespace.clone());
            self.core.send(Command::Apply {
                yaml: self.create_yaml.clone(),
                namespace,
            });
        }
    }

    fn delete_modal(&mut self, ctx: &egui::Context) {
        let Some(pending) = self.pending_delete.clone() else {
            return;
        };
        let place = if pending.namespace.is_empty() {
            pending.name.clone()
        } else {
            format!("{}/{}", pending.namespace, pending.name)
        };
        let mut cancel = false;
        let mut confirm = false;
        let response = egui::Modal::new(egui::Id::new("delete-confirm")).show(ctx, |ui| {
            ui.set_min_width(360.0);
            ui.label(format!("Delete {} {place}?", pending.title));
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if flat_button(ui, "Cancel", TEXT) {
                    cancel = true;
                }
                if flat_button(ui, "Delete", BAD) {
                    confirm = true;
                }
            });
        });
        if cancel || response.should_close() {
            self.pending_delete = None;
        } else if confirm {
            self.core.send(Command::Delete {
                target: pending.target,
                namespace: pending.namespace,
                name: pending.name,
            });
            if let Some(tab) = self.active_tab_mut() {
                tab.selected = None;
                tab.yaml = None;
                tab.yaml_for = None;
            }
            self.pending_delete = None;
        }
    }
}

fn share_bar(ui: &mut egui::Ui, title: &str, parts: &[(&str, u32, Color32)]) {
    let total: u32 = parts.iter().map(|part| part.1).sum();
    if !title.is_empty() {
        ui.label(RichText::new(title).size(13.0).color(TEXT));
        ui.add_space(4.0);
    }
    if total == 0 {
        ui.label(RichText::new("none").size(12.0).color(MUTED));
        return;
    }
    let width = ui.available_width().min(640.0);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 8.0), Sense::hover());
    let mut x = rect.left();
    for (_, value, color) in parts {
        if *value == 0 {
            continue;
        }
        let segment = rect.width() * (*value as f32 / total as f32);
        ui.painter().rect_filled(
            egui::Rect::from_min_size(
                egui::pos2(x, rect.top()),
                Vec2::new(segment.max(1.0), rect.height()),
            ),
            CornerRadius::same(2),
            *color,
        );
        x += segment;
    }
    ui.add_space(4.0);
    ui.horizontal_wrapped(|ui| {
        for (name, value, color) in parts {
            if *value == 0 {
                continue;
            }
            ui.label(
                RichText::new(format!("{name} {value}"))
                    .size(12.0)
                    .color(*color),
            );
        }
    });
}

fn usage_bar(ui: &mut egui::Ui, title: &str, used: f64, total: f64, format: fn(f64) -> String) {
    let ratio = if total > 0.0 {
        (used / total).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let color = if ratio >= 0.9 {
        BAD
    } else if ratio >= 0.75 {
        WARN
    } else {
        ACCENT
    };
    ui.label(
        RichText::new(format!("{title}  {} / {}", format(used), format(total)))
            .size(12.0)
            .color(TEXT),
    );
    let width = ui.available_width().min(640.0);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 8.0), Sense::hover());
    ui.painter()
        .rect_filled(rect, CornerRadius::same(2), SEPARATOR);
    let fill = egui::Rect::from_min_size(
        rect.min,
        Vec2::new(rect.width() * ratio as f32, rect.height()),
    );
    if ratio > 0.0 {
        ui.painter().rect_filled(fill, CornerRadius::same(2), color);
    }
}

fn warning_line(ui: &mut egui::Ui, warning: &OverviewWarning) {
    ui.add_space(4.0);
    let age = if warning.age_secs == u64::MAX {
        "-".to_string()
    } else {
        format_age(warning.age_secs)
    };
    ui.label(
        RichText::new(format!("{}  {}  {age}", warning.reason, warning.object))
            .size(12.0)
            .color(WARN),
    );
    if !warning.message.is_empty() {
        ui.label(RichText::new(&warning.message).size(12.0).color(MUTED));
    }
}

fn section_card(
    ui: &mut egui::Ui,
    title: &str,
    wide: bool,
    add_contents: impl FnOnce(&mut egui::Ui),
) {
    egui::Frame::new()
        .fill(FIELD)
        .stroke(Stroke::new(1.0, SEPARATOR))
        .corner_radius(3)
        .inner_margin(egui::Margin::same(12))
        .show(ui, |ui| {
            if wide {
                ui.set_width(ui.available_width());
            }
            if !title.is_empty() {
                ui.label(RichText::new(title).size(12.0).color(TEXT));
                ui.add_space(8.0);
            }
            add_contents(ui);
        });
    ui.add_space(12.0);
}

fn argo_counts(argo: &ArgoOverview) -> ([u32; 5], [u32; 3]) {
    let mut health = [0u32; 5];
    let mut sync = [0u32; 3];
    for app in &argo.apps {
        match app.health.as_str() {
            "Healthy" => health[0] += 1,
            "Degraded" => health[1] += 1,
            "Progressing" => health[2] += 1,
            "Missing" => health[3] += 1,
            _ => health[4] += 1,
        }
        match app.sync.as_str() {
            "Synced" => sync[0] += 1,
            "OutOfSync" => sync[1] += 1,
            _ => sync[2] += 1,
        }
    }
    (health, sync)
}

fn progress_ring(ui: &mut egui::Ui, value: u32, total: u32, color: Color32) {
    let size = 96.0;
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    let center = rect.center();
    let radius = 34.0;
    let stroke = 6.0;
    paint_arc(
        ui.painter(),
        center,
        radius,
        -std::f32::consts::FRAC_PI_2,
        std::f32::consts::TAU,
        Stroke::new(stroke, SEPARATOR),
    );
    let ratio = if total == 0 {
        0.0
    } else {
        value as f32 / total as f32
    };
    if ratio > 0.0 {
        paint_arc(
            ui.painter(),
            center,
            radius,
            -std::f32::consts::FRAC_PI_2,
            ratio * std::f32::consts::TAU,
            Stroke::new(stroke, color),
        );
    }
    ui.painter().text(
        center,
        Align2::CENTER_CENTER,
        format!("{value}/{total}"),
        FontId::proportional(12.0),
        TEXT,
    );
}

fn paint_arc(
    painter: &egui::Painter,
    center: egui::Pos2,
    radius: f32,
    start: f32,
    sweep: f32,
    stroke: Stroke,
) {
    if sweep.abs() < 0.01 {
        return;
    }
    let steps = ((sweep.abs() / std::f32::consts::TAU) * 72.0)
        .ceil()
        .max(2.0) as usize;
    let mut points = Vec::with_capacity(steps + 1);
    for step in 0..=steps {
        let angle = start + sweep * (step as f32 / steps as f32);
        points.push(center + Vec2::new(angle.cos(), angle.sin()) * radius);
    }
    painter.add(egui::Shape::line(points, stroke));
}

fn status_legend(ui: &mut egui::Ui, parts: &[(&str, u32, Color32)]) {
    let shown: Vec<_> = parts.iter().filter(|part| part.1 > 0).collect();
    if shown.is_empty() {
        return;
    }
    ui.add_space(8.0);
    ui.horizontal_wrapped(|ui| {
        for (name, value, color) in shown {
            ui.label(
                RichText::new(format!("{name} {value}"))
                    .size(12.0)
                    .color(*color),
            );
        }
    });
}

fn app_row(ui: &mut egui::Ui, app: &ArgoApp) -> bool {
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), 28.0), Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(3), HOVER);
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let place = if app.namespace.is_empty() {
        app.name.clone()
    } else {
        format!("{}/{}", app.namespace, app.name)
    };
    ui.painter().text(
        rect.left_center() + Vec2::new(8.0, 0.0),
        Align2::LEFT_CENTER,
        format!("{place}   {}   {}   {}", app.project, app.health, app.sync),
        FontId::proportional(12.0),
        if app.health == "Healthy" { TEXT } else { MUTED },
    );
    response.clicked()
}

fn data_tab(ui: &mut egui::Ui, entries: Option<&[DataEntry]>, ready: bool) {
    if !ready {
        ui.horizontal(|ui| {
            ui.spinner();
            ui.label("Loading values…");
        });
        return;
    }
    let Some(entries) = entries else {
        ui.label(RichText::new("No values.").color(MUTED));
        return;
    };
    if entries.is_empty() {
        ui.label(RichText::new("No keys.").color(MUTED));
        return;
    }
    let width = ui.available_width();
    ScrollArea::vertical()
        .id_salt("object-data")
        .max_width(width)
        .auto_shrink([false, false])
        .show(ui, |ui| {
            for entry in entries {
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    let reserve = if entry.masked { 0.0 } else { 48.0 };
                    let key_width = (ui.available_width() - reserve).max(40.0);
                    ui.scope(|ui| {
                        ui.set_max_width(key_width);
                        wrapping_label(
                            ui,
                            RichText::new(&entry.key)
                                .monospace()
                                .size(12.0)
                                .color(ACCENT),
                        );
                    });
                    if !entry.masked && flat_button(ui, "Copy", TEXT) {
                        ui.ctx().copy_text(entry.value.clone());
                    }
                });
                let shown = if entry.masked {
                    "••••••".to_string()
                } else {
                    preview_value(&entry.value)
                };
                wrapping_label(ui, RichText::new(shown).monospace().size(12.0).color(TEXT));
            }
        });
}

fn preview_value(value: &str) -> String {
    let mut chars = value.chars();
    let head: String = chars.by_ref().take(4000).collect();
    if chars.next().is_some() {
        format!("{head}\n… truncated")
    } else {
        head
    }
}

fn object_template(view: &View, namespace: Option<&str>) -> String {
    let namespace = namespace.unwrap_or("default");
    match view {
        View::Overview | View::Argo => String::new(),
        View::Resource(kind) => kind_template(*kind, namespace),
        View::Custom(target) => {
            let api = if target.group.is_empty() {
                target.version.clone()
            } else {
                format!("{}/{}", target.group, target.version)
            };
            let ns = if target.namespaced {
                format!("  namespace: {namespace}\n")
            } else {
                String::new()
            };
            format!(
                "apiVersion: {api}\nkind: {}\nmetadata:\n  name: example\n{ns}",
                target.kind
            )
        }
    }
}

fn kind_template(kind: ResourceKind, namespace: &str) -> String {
    let (api, name) = kind.manifest();
    let ns = if kind.is_namespaced() {
        format!("  namespace: {namespace}\n")
    } else {
        String::new()
    };
    let body = match kind {
        ResourceKind::ConfigMaps => "data: {}\n",
        ResourceKind::Secrets => "type: Opaque\nstringData: {}\n",
        ResourceKind::Pods => "spec:\n  containers:\n    - name: app\n      image: nginx:1.27\n",
        ResourceKind::Deployments => "spec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: example\n  template:\n    metadata:\n      labels:\n        app: example\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.27\n",
        ResourceKind::Services => "spec:\n  selector:\n    app: example\n  ports:\n    - port: 80\n      targetPort: 80\n",
        _ => "",
    };
    format!("apiVersion: {api}\nkind: {name}\nmetadata:\n  name: example\n{ns}{body}")
}

fn overview_tab(ui: &mut egui::Ui, row: &ResourceRow) {
    let width = ui.available_width();
    ScrollArea::vertical()
        .max_width(width)
        .auto_shrink([false, false])
        .show(ui, |ui| {
            meta_line(ui, "Status", &row.status);
            meta_line(
                ui,
                "Namespace",
                if row.namespace.is_empty() {
                    "-"
                } else {
                    &row.namespace
                },
            );
            meta_line(ui, "Age", &format_age(row.age_secs));
            if !row.ready.is_empty() && row.ready != "-" {
                meta_line(ui, "Ready", &row.ready);
            }
            if !row.info.is_empty() {
                meta_line(ui, "Info", &row.info);
            }
            ui.add_space(8.0);
            ui.label(theme::section_label("LABELS"));
            if row.labels.is_empty() {
                ui.label(RichText::new("none").color(MUTED));
            } else {
                for (key, value) in row.labels.iter().take(32) {
                    wrapping_label(
                        ui,
                        RichText::new(format!("{key}={value}"))
                            .monospace()
                            .size(12.0),
                    );
                }
                if row.labels.len() > 32 {
                    ui.label(
                        RichText::new(format!("… {} more", row.labels.len() - 32)).color(MUTED),
                    );
                }
            }
        });
}

fn meta_line(ui: &mut egui::Ui, key: &str, value: &str) {
    let mut job = egui::text::LayoutJob::default();
    job.wrap.max_width = ui.available_width();
    job.append(
        key,
        0.0,
        egui::TextFormat {
            font_id: FontId::proportional(12.0),
            color: MUTED,
            ..Default::default()
        },
    );
    job.append(
        &format!("  {value}"),
        0.0,
        egui::TextFormat {
            font_id: FontId::proportional(12.0),
            color: TEXT,
            ..Default::default()
        },
    );
    ui.add(egui::Label::new(job).wrap());
}

fn wrapping_label(ui: &mut egui::Ui, text: impl Into<egui::WidgetText>) {
    ui.add(egui::Label::new(text).wrap());
}

fn show_yaml(ui: &mut egui::Ui, yaml: &str) {
    let width = ui.available_width();
    ScrollArea::both()
        .max_width(width)
        .auto_shrink([false, false])
        .show(ui, |ui| {
            for line in yaml.lines() {
                let trimmed = line.trim_start();
                if trimmed.starts_with('#') || trimmed == "---" {
                    wrapping_label(ui, RichText::new(line).monospace().size(12.0).color(MUTED));
                    continue;
                }
                if let Some((key, value)) = split_yaml_key(line) {
                    yaml_line(ui, key, value);
                } else {
                    wrapping_label(ui, RichText::new(line).monospace().size(12.0));
                }
            }
        });
}

fn yaml_line(ui: &mut egui::Ui, key: &str, value: &str) {
    let mut job = egui::text::LayoutJob::default();
    job.wrap.max_width = ui.available_width();
    job.append(
        key,
        0.0,
        egui::TextFormat {
            font_id: FontId::monospace(12.0),
            color: ACCENT,
            ..Default::default()
        },
    );
    job.append(
        value,
        0.0,
        egui::TextFormat {
            font_id: FontId::monospace(12.0),
            color: TEXT,
            ..Default::default()
        },
    );
    ui.add(egui::Label::new(job).wrap());
}

fn split_yaml_key(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('-') || trimmed.is_empty() {
        return None;
    }
    let idx = line.find(':')?;
    let (key, value) = line.split_at(idx + 1);
    Some((key, value))
}

fn stat_card(ui: &mut egui::Ui, title: &str, value: &str, color: egui::Color32) {
    egui::Frame::new()
        .fill(FIELD)
        .stroke(Stroke::new(1.0, SEPARATOR))
        .corner_radius(3)
        .inner_margin(egui::Margin::symmetric(12, 8))
        .show(ui, |ui| {
            ui.set_min_width(150.0);
            ui.label(theme::section_label(title));
            ui.label(RichText::new(value).size(18.0).strong().color(color));
        });
}

fn flat_button(ui: &mut egui::Ui, label: &str, color: Color32) -> bool {
    ui.add(egui::Button::new(RichText::new(label).size(12.0).color(color)).frame(false))
        .clicked()
}

fn glyph_button(
    ui: &mut egui::Ui,
    tip: &str,
    color: Color32,
    paint: fn(&egui::Painter, egui::Rect, Color32),
) -> bool {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(24.0), Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(3), HOVER);
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    paint(ui.painter(), rect, color);
    response.on_hover_text(tip).clicked()
}

fn paint_trash(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
    let center = rect.center();
    let stroke = Stroke::new(1.3, color);
    let lid = center.y - 3.5;
    painter.line_segment(
        [
            egui::pos2(center.x - 5.5, lid),
            egui::pos2(center.x + 5.5, lid),
        ],
        stroke,
    );
    painter.line_segment(
        [
            egui::pos2(center.x - 2.0, lid),
            egui::pos2(center.x - 2.0, lid - 2.2),
        ],
        stroke,
    );
    painter.line_segment(
        [
            egui::pos2(center.x + 2.0, lid),
            egui::pos2(center.x + 2.0, lid - 2.2),
        ],
        stroke,
    );
    painter.line_segment(
        [
            egui::pos2(center.x - 2.0, lid - 2.2),
            egui::pos2(center.x + 2.0, lid - 2.2),
        ],
        stroke,
    );
    let body = egui::Rect::from_min_max(
        egui::pos2(center.x - 4.5, lid + 1.6),
        egui::pos2(center.x + 4.5, center.y + 6.0),
    );
    painter.rect_stroke(body, 1.0, stroke, egui::StrokeKind::Inside);
    for x in [center.x - 1.6, center.x + 1.6] {
        painter.line_segment(
            [egui::pos2(x, lid + 3.4), egui::pos2(x, center.y + 4.2)],
            stroke,
        );
    }
}

fn paint_restart(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
    let center = rect.center();
    let radius = 5.5;
    let stroke = Stroke::new(1.4, color);
    let steps = 16;
    let start = 0.6_f32;
    let sweep = 5.0_f32;
    let mut points = Vec::with_capacity(steps + 1);
    for step in 0..=steps {
        let angle = start + sweep * (step as f32 / steps as f32);
        points.push(center + Vec2::new(angle.cos(), angle.sin()) * radius);
    }
    for pair in points.windows(2) {
        painter.line_segment([pair[0], pair[1]], stroke);
    }
    let end = points[points.len() - 1];
    let prev = points[points.len() - 2];
    let travel = (end - prev).normalized();
    let side = Vec2::new(-travel.y, travel.x);
    let tip = end + travel * 3.2;
    painter.line_segment([tip, end - travel * 0.4 + side * 2.6], stroke);
    painter.line_segment([tip, end - travel * 0.4 - side * 2.6], stroke);
}

fn section_open(ui: &egui::Ui, salt: &str) -> bool {
    ui.ctx()
        .data_mut(|data| data.get_persisted(egui::Id::new(salt)))
        .unwrap_or(false)
}

fn set_section_open(ui: &egui::Ui, salt: &str, open: bool) {
    ui.ctx()
        .data_mut(|data| data.insert_persisted(egui::Id::new(salt), open));
}

fn paint_chevron(painter: &egui::Painter, center: egui::Pos2, open: bool, color: Color32) {
    let stroke = Stroke::new(1.4, color);
    if open {
        painter.line_segment(
            [center + Vec2::new(-3.5, -1.5), center + Vec2::new(0.0, 2.0)],
            stroke,
        );
        painter.line_segment(
            [center + Vec2::new(0.0, 2.0), center + Vec2::new(3.5, -1.5)],
            stroke,
        );
    } else {
        painter.line_segment(
            [center + Vec2::new(-1.5, -3.5), center + Vec2::new(2.0, 0.0)],
            stroke,
        );
        painter.line_segment(
            [center + Vec2::new(2.0, 0.0), center + Vec2::new(-1.5, 3.5)],
            stroke,
        );
    }
}

fn group_header(ui: &mut egui::Ui, label: &str, count: usize, open: bool, indent: f32) -> bool {
    let width = ui.available_width();
    let (full, response) = ui.allocate_exact_size(Vec2::new(width, 28.0), Sense::click());
    let rect = egui::Rect::from_min_max(
        full.min + Vec2::new(6.0 + indent, 1.0),
        full.max - Vec2::new(6.0, 1.0),
    );
    let hovered = ui.rect_contains_pointer(full);
    if hovered {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        ui.painter().rect_filled(rect, CornerRadius::same(6), HOVER);
    }
    let color = TEXT;
    paint_chevron(
        ui.painter(),
        egui::pos2(rect.left() + 12.0, rect.center().y),
        open,
        if hovered { TEXT } else { MUTED },
    );
    let clip = egui::Rect::from_min_max(
        egui::pos2(rect.left() + 22.0, rect.top()),
        egui::pos2(rect.right() - 8.0, rect.bottom()),
    );
    let count_label = format!("{count}");
    let count_w = if open {
        0.0
    } else {
        ui.painter()
            .layout_no_wrap(count_label.clone(), FontId::proportional(12.0), MUTED)
            .size()
            .x
            + 10.0
    };
    let name_clip =
        egui::Rect::from_min_max(clip.min, egui::pos2(clip.right() - count_w, clip.bottom()));
    paint_strong(
        &ui.painter().with_clip_rect(name_clip),
        egui::pos2(clip.left(), rect.center().y),
        label,
        12.0,
        color,
    );
    if !open {
        let name_w = ui
            .painter()
            .layout_no_wrap(label.to_owned(), FontId::proportional(12.0), color)
            .size()
            .x;
        ui.painter().with_clip_rect(clip).text(
            egui::pos2(
                (clip.left() + name_w + 8.0).min(clip.right() - count_w + 8.0),
                rect.center().y,
            ),
            Align2::LEFT_CENTER,
            count_label,
            FontId::proportional(12.0),
            MUTED,
        );
    }
    response
        .on_hover_text(if open {
            "Hide these resources"
        } else {
            "Show these resources"
        })
        .clicked()
}

fn resource_row(ui: &mut egui::Ui, label: &str, selected: bool, indent: f32) -> bool {
    let width = ui.available_width();
    let (full, response) = ui.allocate_exact_size(Vec2::new(width, 28.0), Sense::click());
    let rect = egui::Rect::from_min_max(
        full.min + Vec2::new(6.0 + indent, 3.0),
        full.max - Vec2::new(6.0, 3.0),
    );
    let hovered = ui.rect_contains_pointer(full);
    if hovered {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let fill = if selected {
        theme::ROW_SELECTED
    } else if hovered {
        HOVER
    } else {
        Color32::TRANSPARENT
    };
    if fill != Color32::TRANSPARENT {
        ui.painter().rect_filled(rect, CornerRadius::same(6), fill);
    }
    if selected {
        ui.painter()
            .circle_filled(egui::pos2(rect.left() + 12.0, rect.center().y), 2.5, ACCENT);
    }
    let text_color = if selected { TEXT } else { MUTED };
    let label_rect = egui::Rect::from_min_max(
        egui::pos2(rect.left() + 20.0, rect.top()),
        egui::pos2(rect.right() - 8.0, rect.bottom()),
    );
    ui.scope_builder(egui::UiBuilder::new().max_rect(label_rect), |ui| {
        ui.set_min_width(label_rect.width().max(8.0));
        ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
            ui.add(
                egui::Label::new(RichText::new(label).size(12.0).color(text_color))
                    .truncate()
                    .selectable(false),
            );
        });
    });
    response.clicked()
}

fn installed_gateway(targets: &[CrTarget]) -> Vec<ResourceKind> {
    let Some((_, kinds)) = NAV.iter().find(|(title, _)| *title == "Gateway") else {
        return Vec::new();
    };
    kinds
        .iter()
        .copied()
        .filter(|kind| {
            let Some(plural) = kind.gateway_plural() else {
                return false;
            };
            targets.iter().any(|target| {
                target.group == "gateway.networking.k8s.io" && target.plural == plural
            })
        })
        .collect()
}

fn title_of(view: &View) -> String {
    match view {
        View::Overview => "Overview".to_string(),
        View::Argo => "Argo CD".to_string(),
        View::Resource(kind) => kind.title().to_string(),
        View::Custom(target) => target.kind.clone(),
    }
}

fn watch_of(view: &View) -> Option<WatchTarget> {
    match view {
        View::Overview | View::Argo => None,
        View::Resource(kind) => Some(WatchTarget::Kind(*kind)),
        View::Custom(target) => Some(WatchTarget::Custom(target.clone())),
    }
}

fn hit_label(hit: &SearchHit) -> (String, String) {
    match hit {
        SearchHit::View(view) => (title_of(view), String::new()),
        SearchHit::Object {
            name, namespace, ..
        } => (name.clone(), namespace.clone()),
    }
}

fn text_tab(ui: &mut egui::Ui, label: &str, active: bool) -> bool {
    let width = (label.len() as f32).mul_add(7.2, 16.0).max(28.0);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, 24.0), Sense::click());
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    ui.painter().text(
        rect.left_center() + Vec2::new(8.0, 0.0),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(12.0),
        if active { TEXT } else { MUTED },
    );
    if active {
        ui.painter().hline(
            (rect.left() + 8.0)..=(rect.right() - 4.0),
            rect.bottom() - 1.0,
            Stroke::new(2.0, ACCENT),
        );
    }
    response.clicked()
}

fn column_widths(cols: &[Col], view_w: f32) -> Vec<f32> {
    let mut widths: Vec<f32> = cols.iter().map(|col| col.width.max(col.min)).collect();
    let sum: f32 = widths.iter().sum();
    let inner = (view_w - 8.0).max(sum);
    if let Some(last) = widths.last_mut() {
        if sum < inner {
            *last += inner - sum;
        }
    }
    widths
}

fn paint_table_header(
    ui: &mut egui::Ui,
    header_rect: egui::Rect,
    cols: &[Col],
    widths: &[f32],
    offset_x: f32,
    sort: Field,
    asc: bool,
) -> Option<Field> {
    let painter = ui.painter().with_clip_rect(header_rect);
    painter.hline(
        header_rect.x_range(),
        header_rect.bottom() - 0.5,
        Stroke::new(1.0, SEPARATOR),
    );
    let mut clicked = None;
    let mut x = header_rect.left() - offset_x;
    for (col, width) in cols.iter().zip(widths) {
        let cell = egui::Rect::from_min_size(
            egui::pos2(x, header_rect.top()),
            Vec2::new(*width, header_rect.height()),
        );
        let visible = cell.intersect(header_rect);
        if visible.is_positive() {
            let response = ui.interact(visible, ui.id().with(("col", col.title)), Sense::click());
            if response.hovered() {
                ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                ui.painter().rect_filled(visible, CornerRadius::ZERO, HOVER);
            }
            if response.clicked() {
                clicked = Some(col.field);
            }
        }
        let cell_painter = painter.with_clip_rect(cell);
        let text_pos = egui::pos2(cell.left() + 8.0, cell.center().y);
        let galley =
            cell_painter.layout_no_wrap(col.title.to_owned(), FontId::proportional(12.0), MUTED);
        let text_w = galley.size().x;
        cell_painter.galley(
            text_pos - Vec2::new(0.0, galley.size().y * 0.5),
            galley,
            MUTED,
        );
        if sort == col.field {
            paint_caret(
                &cell_painter,
                egui::pos2(cell.left() + 8.0 + text_w + 8.0, cell.center().y),
                !asc,
                MUTED,
            );
        }
        x += *width;
    }
    clicked
}

fn paint_table_row(
    painter: &egui::Painter,
    rect: egui::Rect,
    cols: &[Col],
    widths: &[f32],
    row: &ResourceRow,
) {
    let mut x = rect.left();
    for (col, width) in cols.iter().zip(widths) {
        let cell =
            egui::Rect::from_min_size(egui::pos2(x, rect.top()), Vec2::new(*width, rect.height()));
        let clip = painter.with_clip_rect(cell);
        let text = field_text(row, col.field);
        let mut text_x = cell.left() + 8.0;
        let color = if col.colored {
            tone_color(row.tone)
        } else if col.field == Field::Name {
            TEXT
        } else {
            MUTED
        };
        if col.colored {
            clip.circle_filled(egui::pos2(text_x + 3.0, cell.center().y), 3.5, color);
            text_x += 14.0;
        }
        clip.text(
            egui::pos2(text_x, cell.center().y),
            Align2::LEFT_CENTER,
            text,
            FontId::proportional(12.0),
            color,
        );
        x += *width;
    }
}

fn paint_strong(painter: &egui::Painter, pos: egui::Pos2, text: &str, size: f32, color: Color32) {
    let font = FontId::proportional(size);
    painter.text(pos, Align2::LEFT_CENTER, text, font.clone(), color);
    painter.text(
        pos + Vec2::new(0.55, 0.0),
        Align2::LEFT_CENTER,
        text,
        font,
        color,
    );
}

fn paint_caret(painter: &egui::Painter, center: egui::Pos2, down: bool, color: Color32) {
    let stroke = Stroke::new(1.3, color);
    if down {
        painter.line_segment(
            [center + Vec2::new(-3.0, -1.2), center + Vec2::new(0.0, 1.8)],
            stroke,
        );
        painter.line_segment(
            [center + Vec2::new(0.0, 1.8), center + Vec2::new(3.0, -1.2)],
            stroke,
        );
    } else {
        painter.line_segment(
            [center + Vec2::new(-3.0, 1.2), center + Vec2::new(0.0, -1.8)],
            stroke,
        );
        painter.line_segment(
            [center + Vec2::new(0.0, -1.8), center + Vec2::new(3.0, 1.2)],
            stroke,
        );
    }
}

fn columns_for(view: &View) -> Vec<Col> {
    let mut cols = vec![col("Name", Field::Name, false, 220.0, 140.0)];
    let namespaced = match view {
        View::Custom(target) => target.namespaced,
        View::Resource(kind) => kind.is_namespaced(),
        View::Overview | View::Argo => false,
    };
    if namespaced {
        cols.push(col("Namespace", Field::Namespace, false, 140.0, 90.0));
    }
    let kind = match view {
        View::Resource(kind) => Some(*kind),
        _ => None,
    };
    let middle: &[(&str, Field, bool)] = match kind {
        Some(ResourceKind::Pods) => &[
            ("Status", Field::Status, true),
            ("Ready", Field::Ready, false),
            ("Restarts", Field::Cell("restarts"), false),
            ("Node", Field::Cell("node"), false),
            ("CPU", Field::Cpu, false),
            ("Memory", Field::Memory, false),
        ],
        Some(ResourceKind::Nodes) => &[
            ("Status", Field::Status, true),
            ("Roles", Field::Info, false),
            ("Kubelet", Field::Ready, false),
            ("CPU", Field::Cpu, false),
            ("Memory", Field::Memory, false),
        ],
        Some(
            ResourceKind::Deployments
            | ResourceKind::ReplicaSets
            | ResourceKind::StatefulSets
            | ResourceKind::DaemonSets,
        ) => &[
            ("Status", Field::Status, true),
            ("Ready", Field::Ready, false),
        ],
        Some(ResourceKind::Jobs) => &[
            ("Status", Field::Status, true),
            ("Completions", Field::Ready, false),
        ],
        Some(ResourceKind::CronJobs) => &[
            ("Schedule", Field::Info, false),
            ("Suspend", Field::Status, true),
            ("Active", Field::Ready, false),
        ],
        Some(ResourceKind::Services) => &[
            ("Type", Field::Status, false),
            ("Cluster IP", Field::Ready, false),
            ("Ports", Field::Info, false),
        ],
        Some(ResourceKind::Endpoints) => &[
            ("Status", Field::Status, true),
            ("Addresses", Field::Ready, false),
            ("Not ready", Field::Info, false),
        ],
        Some(ResourceKind::EndpointSlices) => &[
            ("Address type", Field::Status, false),
            ("Endpoints", Field::Ready, false),
        ],
        Some(ResourceKind::Ingresses) => &[
            ("Class", Field::Ready, false),
            ("Hosts", Field::Info, false),
        ],
        Some(ResourceKind::IngressClasses) => &[("Controller", Field::Ready, false)],
        Some(ResourceKind::GatewayClasses) => &[("Controller", Field::Cell("controller"), false)],
        Some(ResourceKind::NetworkPolicies) => &[
            ("Types", Field::Ready, false),
            ("Rules", Field::Info, false),
        ],
        Some(ResourceKind::ConfigMaps) => {
            &[("Keys", Field::Ready, false), ("Data", Field::Info, false)]
        }
        Some(ResourceKind::Secrets) => &[
            ("Keys", Field::Ready, false),
            ("Type", Field::Status, false),
        ],
        Some(ResourceKind::ResourceQuotas) => {
            &[("Used", Field::Ready, false), ("Hard", Field::Info, false)]
        }
        Some(ResourceKind::LimitRanges) => &[
            ("Limits", Field::Ready, false),
            ("Types", Field::Info, false),
        ],
        Some(ResourceKind::HorizontalPodAutoscalers) => &[
            ("Replicas", Field::Ready, false),
            ("Target", Field::Info, false),
        ],
        Some(ResourceKind::PodDisruptionBudgets) => &[
            ("Healthy", Field::Ready, false),
            ("Budget", Field::Info, false),
        ],
        Some(ResourceKind::PersistentVolumeClaims | ResourceKind::PersistentVolumes) => &[
            ("Phase", Field::Status, true),
            ("Size", Field::Ready, false),
            ("Class", Field::Cell("class"), false),
        ],
        Some(ResourceKind::StorageClasses) => &[
            ("Provisioner", Field::Info, false),
            ("Reclaim", Field::Ready, false),
        ],
        Some(ResourceKind::ServiceAccounts) => &[
            ("Secrets", Field::Ready, false),
            ("Pull secrets", Field::Info, false),
        ],
        Some(ResourceKind::Roles | ResourceKind::ClusterRoles) => &[("Rules", Field::Ready, false)],
        Some(ResourceKind::RoleBindings | ResourceKind::ClusterRoleBindings) => &[
            ("Subjects", Field::Ready, false),
            ("Role", Field::Info, false),
        ],
        Some(ResourceKind::Namespaces) => &[("Phase", Field::Status, true)],
        Some(ResourceKind::Events) => &[
            ("Reason", Field::Cell("reason"), true),
            ("Object", Field::Cell("object"), false),
            ("Count", Field::Cell("count"), false),
            ("Message", Field::Cell("message"), false),
        ],
        Some(ResourceKind::CustomResourceDefinitions) => &[
            ("Established", Field::Status, true),
            ("Scope", Field::Ready, false),
            ("Group", Field::Info, false),
        ],
        Some(ResourceKind::Gateways) => &[
            ("Class", Field::Cell("class"), false),
            ("Listeners", Field::Cell("listeners"), false),
            ("Addresses", Field::Cell("addresses"), false),
        ],
        Some(ResourceKind::HttpRoutes | ResourceKind::GrpcRoutes | ResourceKind::TlsRoutes) => &[
            ("Hostnames", Field::Cell("hostnames"), false),
            ("Parent", Field::Cell("parent"), false),
        ],
        Some(ResourceKind::TcpRoutes | ResourceKind::UdpRoutes) => &[
            ("Parent", Field::Cell("parent"), false),
            ("Backends", Field::Cell("backends"), false),
        ],
        Some(ResourceKind::BackendTLSPolicies) => &[
            ("Target", Field::Cell("target"), false),
            ("Hostname", Field::Cell("hostname"), false),
        ],
        Some(ResourceKind::ReferenceGrants) => &[
            ("From", Field::Cell("from"), false),
            ("To", Field::Cell("to"), false),
        ],
        Some(ResourceKind::ListenerSets) => &[
            ("Gateway", Field::Cell("gateway"), false),
            ("Listeners", Field::Cell("listeners"), false),
        ],
        None => &[("Status", Field::Status, true)],
    };
    for (title, field, colored) in middle {
        let width = if matches!(field, Field::Cpu | Field::Memory) {
            110.0
        } else {
            140.0
        };
        cols.push(col(title, *field, *colored, width, 70.0));
    }
    cols.push(col("Age", Field::Age, false, 72.0, 52.0));
    cols
}

fn col(title: &'static str, field: Field, colored: bool, width: f32, min: f32) -> Col {
    Col {
        title,
        field,
        colored,
        width,
        min,
    }
}

fn field_text(row: &ResourceRow, field: Field) -> String {
    let text = match field {
        Field::Name => row.name.clone(),
        Field::Namespace => row.namespace.clone(),
        Field::Age => format_age(row.age_secs),
        Field::Status => row.status.clone(),
        Field::Ready => row.ready.clone(),
        Field::Info => row.info.clone(),
        Field::Cpu => format_cpu_pair(row.cpu_millis, row.cpu_request_millis),
        Field::Memory => format_bytes_pair(row.mem_bytes, row.mem_request_bytes),
        Field::Cell(key) => row.cells.get(key).cloned().unwrap_or_default(),
    };
    if text.is_empty() {
        "-".to_string()
    } else {
        text
    }
}

fn cr_groups(targets: &[CrTarget]) -> Vec<(String, Vec<CrTarget>)> {
    let mut groups: BTreeMap<String, Vec<CrTarget>> = BTreeMap::new();
    for target in targets {
        if target.group == "gateway.networking.k8s.io" {
            continue;
        }
        groups
            .entry(target.group.clone())
            .or_default()
            .push(target.clone());
    }
    for kinds in groups.values_mut() {
        kinds.sort_by(|a, b| a.kind.cmp(&b.kind));
    }
    groups.into_iter().collect()
}

fn cluster_chip(ui: &mut egui::Ui, ctx: &ContextInfo, active: bool) -> bool {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(36.0), Sense::click());
    let painter = ui.painter();
    painter.rect_filled(rect, 3, FIELD);
    let strip = egui::Rect::from_min_size(rect.min, Vec2::new(3.0, rect.height()));
    painter.rect_filled(strip, 0, cluster_color(&ctx.name));
    if active {
        painter.rect_stroke(rect, 3, Stroke::new(1.5, ACCENT), egui::StrokeKind::Inside);
    }
    painter.text(
        rect.center(),
        Align2::CENTER_CENTER,
        initials(&ctx.name),
        FontId::proportional(12.0),
        TEXT,
    );
    let hover = if ctx.cluster.is_empty() {
        ctx.name.clone()
    } else {
        format!("{}\n{}", ctx.name, ctx.cluster)
    };
    response.on_hover_text(hover).clicked()
}

fn cluster_color(name: &str) -> Color32 {
    const PALETTE: [Color32; 8] = [
        Color32::from_rgb(91, 141, 239),
        Color32::from_rgb(62, 207, 142),
        Color32::from_rgb(245, 165, 36),
        Color32::from_rgb(196, 120, 232),
        Color32::from_rgb(72, 190, 210),
        Color32::from_rgb(232, 112, 138),
        Color32::from_rgb(120, 168, 96),
        Color32::from_rgb(230, 126, 80),
    ];
    let mut hash: u32 = 2_166_136_261;
    for byte in name.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    PALETTE[(hash as usize) % PALETTE.len()]
}

fn initials(name: &str) -> String {
    let parts: Vec<&str> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect();
    let letters: String = if parts.len() >= 2 {
        let mut chars = String::new();
        if let Some(c) = parts[0].chars().next() {
            chars.push(c);
        }
        if let Some(c) = parts[1].chars().next() {
            chars.push(c);
        }
        chars
    } else {
        name.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(2)
            .collect()
    };
    let upper = letters.to_uppercase();
    if upper.is_empty() {
        "?".to_string()
    } else {
        upper
    }
}

fn compare_rows(a: &ResourceRow, b: &ResourceRow, sort: Field, asc: bool) -> std::cmp::Ordering {
    let ordering = match sort {
        Field::Name => a.name.cmp(&b.name),
        Field::Namespace => a.namespace.cmp(&b.namespace).then(a.name.cmp(&b.name)),
        Field::Status => a.status.cmp(&b.status).then(a.name.cmp(&b.name)),
        Field::Ready => a.ready.cmp(&b.ready).then(a.name.cmp(&b.name)),
        Field::Age => a.age_secs.cmp(&b.age_secs).then(a.name.cmp(&b.name)),
        Field::Info => a.info.cmp(&b.info).then(a.name.cmp(&b.name)),
        Field::Cell(key) => a
            .cells
            .get(key)
            .map(String::as_str)
            .unwrap_or("")
            .cmp(b.cells.get(key).map(String::as_str).unwrap_or(""))
            .then(a.name.cmp(&b.name)),
        Field::Cpu => return cmp_num(a.cpu_millis, b.cpu_millis, asc).then(a.name.cmp(&b.name)),
        Field::Memory => return cmp_num(a.mem_bytes, b.mem_bytes, asc).then(a.name.cmp(&b.name)),
    };
    if asc {
        ordering
    } else {
        ordering.reverse()
    }
}

fn cmp_num(a: Option<f64>, b: Option<f64>, asc: bool) -> std::cmp::Ordering {
    match (a, b) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(a), Some(b)) => {
            let ordering = a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal);
            if asc {
                ordering
            } else {
                ordering.reverse()
            }
        }
    }
}

pub fn run() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([1024.0, 680.0])
            .with_title("Kubi")
            .with_app_id("kubi"),
        renderer: eframe::Renderer::Wgpu,
        ..Default::default()
    };
    eframe::run_native(
        "Kubi",
        options,
        Box::new(|cc| {
            theme::apply(&cc.egui_ctx);
            Ok(Box::new(KubiApp::new()))
        }),
    )
}
