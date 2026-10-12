use std::collections::BTreeMap;

use crate::metrics_types::{NodeMetrics, PodMetrics};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Endpoints, Event, LimitRange, Namespace, Node, PersistentVolume,
    PersistentVolumeClaim, Pod, ResourceQuota, Secret, Service, ServiceAccount,
};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{Ingress, IngressClass, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::api::storage::v1::StorageClass;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::core::DynamicObject;
use kube::ResourceExt;

use crate::model::{ResourceRow, StatusTone, UsageSample};
use crate::quantity::{parse_bytes, parse_cpu_millis};

pub(crate) fn pod_row(pod: &Pod) -> ResourceRow {
    let (status, tone) = pod_status(pod);
    let ready = pod_ready(pod);
    let (cpu_req, mem_req) = pod_requests(pod);
    let restarts = pod
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .map(|statuses| statuses.iter().map(|cs| cs.restart_count).sum::<i32>())
        .unwrap_or(0);
    let node = pod
        .spec
        .as_ref()
        .and_then(|spec| spec.node_name.clone())
        .unwrap_or_else(|| "-".to_string());
    let mut row = make_row(
        &pod.metadata,
        status,
        tone,
        ready,
        format!("{restarts} restarts · {node}"),
        cpu_req,
        mem_req,
    );
    cell(&mut row, "restarts", restarts.to_string());
    cell(&mut row, "node", node);
    cell(
        &mut row,
        "podIP",
        pod.status
            .as_ref()
            .and_then(|status| status.pod_ip.clone())
            .unwrap_or_default(),
    );
    cell(
        &mut row,
        "qos",
        pod.status
            .as_ref()
            .and_then(|status| status.qos_class.clone())
            .unwrap_or_default(),
    );
    cell(
        &mut row,
        "images",
        pod.spec
            .as_ref()
            .map(|spec| images_of(&spec.containers))
            .unwrap_or_default(),
    );
    row
}

pub(crate) fn deployment_row(item: &Deployment) -> ResourceRow {
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(0);
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let (status, tone, ready_col) = replica_status(ready, desired);
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        ready_col,
        String::new(),
        None,
        None,
    );
    if let Some(workload) = item.status.as_ref() {
        cell(&mut row, "updated", workload.updated_replicas.unwrap_or(0).to_string());
        cell(
            &mut row,
            "available",
            workload.available_replicas.unwrap_or(0).to_string(),
        );
        let unavailable = workload.unavailable_replicas.unwrap_or(0);
        if unavailable > 0 {
            cell(&mut row, "unavailable", unavailable.to_string());
        }
    }
    cell(&mut row, "strategy", deployment_strategy(item));
    cell(
        &mut row,
        "images",
        template_images(
            item.spec
                .as_ref()
                .and_then(|spec| spec.template.spec.as_ref()),
        ),
    );
    row
}

fn deployment_strategy(item: &Deployment) -> String {
    let Some(strategy) = item.spec.as_ref().and_then(|spec| spec.strategy.as_ref()) else {
        return String::new();
    };
    let kind = strategy
        .type_
        .clone()
        .unwrap_or_else(|| "RollingUpdate".to_string());
    if kind != "RollingUpdate" {
        return kind;
    }
    let Some(rolling) = &strategy.rolling_update else {
        return kind;
    };
    let mut parts = vec![kind];
    if let Some(max_unavailable) = &rolling.max_unavailable {
        parts.push(format!("max unavailable {}", int_or_string(max_unavailable)));
    }
    if let Some(max_surge) = &rolling.max_surge {
        parts.push(format!("max surge {}", int_or_string(max_surge)));
    }
    parts.join(", ")
}

pub(crate) fn statefulset_row(item: &StatefulSet) -> ResourceRow {
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(0);
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let (status, tone, ready_col) = replica_status(ready, desired);
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        ready_col,
        String::new(),
        None,
        None,
    );
    if let Some(workload) = item.status.as_ref() {
        cell(&mut row, "current", workload.current_replicas.unwrap_or(0).to_string());
        cell(&mut row, "updated", workload.updated_replicas.unwrap_or(0).to_string());
    }
    if let Some(spec) = item.spec.as_ref() {
        cell(&mut row, "service", spec.service_name.clone().unwrap_or_default());
        cell(
            &mut row,
            "podManagement",
            spec.pod_management_policy.clone().unwrap_or_default(),
        );
        cell(&mut row, "images", template_images(spec.template.spec.as_ref()));
    }
    row
}

pub(crate) fn daemonset_row(item: &DaemonSet) -> ResourceRow {
    let desired = item
        .status
        .as_ref()
        .map(|status| status.desired_number_scheduled)
        .unwrap_or(0);
    let ready = item
        .status
        .as_ref()
        .map(|status| status.number_ready)
        .unwrap_or(0);
    let (status, tone, ready_col) = replica_status(ready, desired);
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        ready_col,
        String::new(),
        None,
        None,
    );
    if let Some(workload) = item.status.as_ref() {
        cell(
            &mut row,
            "current",
            workload.current_number_scheduled.to_string(),
        );
        cell(
            &mut row,
            "updated",
            workload.updated_number_scheduled.unwrap_or(0).to_string(),
        );
        cell(
            &mut row,
            "available",
            workload.number_available.unwrap_or(0).to_string(),
        );
        if workload.number_misscheduled > 0 {
            cell(&mut row, "misscheduled", workload.number_misscheduled.to_string());
        }
    }
    if let Some(spec) = item.spec.as_ref() {
        cell(&mut row, "images", template_images(spec.template.spec.as_ref()));
    }
    row
}

pub(crate) fn job_row(item: &Job) -> ResourceRow {
    let completions = item
        .spec
        .as_ref()
        .and_then(|spec| spec.completions)
        .unwrap_or(1);
    let succeeded = item
        .status
        .as_ref()
        .and_then(|status| status.succeeded)
        .unwrap_or(0);
    let failed = item
        .status
        .as_ref()
        .and_then(|status| status.failed)
        .unwrap_or(0);
    let (status, tone) = if failed > 0 && succeeded < completions {
        ("Failed".to_string(), StatusTone::Bad)
    } else if succeeded >= completions {
        ("Complete".to_string(), StatusTone::Ok)
    } else {
        ("Running".to_string(), StatusTone::Warn)
    };
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        format!("{succeeded}/{completions}"),
        if failed > 0 {
            format!("{failed} failed")
        } else {
            String::new()
        },
        None,
        None,
    );
    if let Some(spec) = item.spec.as_ref() {
        cell(&mut row, "parallelism", spec.parallelism.unwrap_or(1).to_string());
        cell(&mut row, "backoff", spec.backoff_limit.unwrap_or(6).to_string());
        cell(&mut row, "images", template_images(spec.template.spec.as_ref()));
    }
    row
}

pub(crate) fn node_row(node: &Node) -> ResourceRow {
    let (status, tone) = node_status(node);
    let (cpu_alloc, mem_alloc) = node_allocatable(node);
    let version = node
        .status
        .as_ref()
        .and_then(|status| status.node_info.as_ref())
        .map(|info| info.kubelet_version.clone())
        .unwrap_or_else(|| "-".to_string());
    let mut row = make_row(
        &node.metadata,
        status,
        tone,
        version,
        node_roles(node),
        cpu_alloc,
        mem_alloc,
    );
    let node_status = node.status.as_ref();
    cell(
        &mut row,
        "internalIP",
        node_status
            .and_then(|status| status.addresses.as_ref())
            .and_then(|addresses| {
                addresses
                    .iter()
                    .find(|address| address.type_ == "InternalIP")
                    .map(|address| address.address.clone())
            })
            .unwrap_or_default(),
    );
    if let Some(info) = node_status.and_then(|status| status.node_info.as_ref()) {
        cell(&mut row, "os", info.os_image.clone());
        cell(&mut row, "runtime", info.container_runtime_version.clone());
    }
    cell(
        &mut row,
        "pods",
        node_status
            .and_then(|status| status.allocatable.as_ref())
            .and_then(|allocatable| allocatable.get("pods"))
            .map(|qty| qty_str(qty).to_string())
            .unwrap_or_default(),
    );
    row
}

pub(crate) fn event_row(event: &Event) -> ResourceRow {
    let kind = event.involved_object.kind.as_deref().unwrap_or("Object");
    let involved = event
        .involved_object
        .name
        .clone()
        .unwrap_or_else(|| event.name_any());
    let reason = event.reason.clone().unwrap_or_default();
    let message = event.message.clone().unwrap_or_default();
    let ty = event.type_.clone().unwrap_or_else(|| "Normal".to_string());
    let tone = if ty == "Warning" {
        StatusTone::Warn
    } else {
        StatusTone::Neutral
    };
    let count = event.count.unwrap_or(1);
    let mut row = make_row(
        &event.metadata,
        ty.clone(),
        tone,
        count.to_string(),
        truncate(&format!("{kind}/{involved} · {reason}: {message}"), 160),
        None,
        None,
    );
    cell(&mut row, "reason", reason);
    cell(&mut row, "object", format!("{kind}/{involved}"));
    cell(&mut row, "count", count.to_string());
    cell(&mut row, "message", truncate(&message, 120));
    cell(&mut row, "type", ty);
    cell(
        &mut row,
        "source",
        event
            .source
            .as_ref()
            .and_then(|source| source.component.clone())
            .or_else(|| event.reporting_component.clone())
            .unwrap_or_default(),
    );
    cell(
        &mut row,
        "lastSeen",
        event
            .last_timestamp
            .as_ref()
            .map(time_text)
            .unwrap_or_default(),
    );
    if let Some(ts) = event.last_timestamp.as_ref() {
        row.age_secs = time_age(ts);
    }
    row
}

pub(crate) fn service_row(service: &Service) -> ResourceRow {
    let ty = service
        .spec
        .as_ref()
        .and_then(|spec| spec.type_.clone())
        .unwrap_or_else(|| "ClusterIP".to_string());
    let ip = service
        .spec
        .as_ref()
        .and_then(|spec| spec.cluster_ip.clone())
        .unwrap_or_else(|| "-".to_string());
    let ports = service
        .spec
        .as_ref()
        .and_then(|spec| spec.ports.as_ref())
        .map(|ports| {
            ports
                .iter()
                .map(|port| {
                    let proto = port.protocol.as_deref().unwrap_or("TCP");
                    format!("{}/{}", port.port, proto)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let load_balancer = ty == "LoadBalancer";
    let mut row = make_row(&service.metadata, ty, StatusTone::Ok, ip, ports, None, None);
    if load_balancer {
        cell(&mut row, "externalIP", service_external(service));
    }
    cell(
        &mut row,
        "selector",
        service
            .spec
            .as_ref()
            .and_then(|spec| spec.selector.as_ref())
            .map(selector_line)
            .unwrap_or_default(),
    );
    row
}

fn service_external(service: &Service) -> String {
    let addresses = service
        .status
        .as_ref()
        .and_then(|status| status.load_balancer.as_ref())
        .and_then(|balancer| balancer.ingress.as_ref())
        .map(|ingress| {
            ingress
                .iter()
                .filter_map(|item| {
                    item.ip
                        .clone()
                        .filter(|value| !value.is_empty())
                        .or_else(|| item.hostname.clone().filter(|value| !value.is_empty()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if addresses.is_empty() {
        "Pending".to_string()
    } else {
        addresses.join(", ")
    }
}

pub(crate) fn ingress_row(ingress: &Ingress) -> ResourceRow {
    let class = ingress
        .spec
        .as_ref()
        .and_then(|spec| spec.ingress_class_name.clone())
        .unwrap_or_else(|| "-".to_string());
    let hosts = ingress
        .spec
        .as_ref()
        .and_then(|spec| spec.rules.as_ref())
        .map(|rules| {
            rules
                .iter()
                .filter_map(|rule| rule.host.clone())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let (status, tone) = if hosts.is_empty() {
        ("Pending".to_string(), StatusTone::Warn)
    } else {
        ("Ready".to_string(), StatusTone::Ok)
    };
    let mut row = make_row(&ingress.metadata, status, tone, class, hosts, None, None);
    cell(&mut row, "addresses", ingress_addresses(ingress));
    cell(&mut row, "tls", ingress_tls(ingress));
    row
}

fn ingress_addresses(ingress: &Ingress) -> String {
    ingress
        .status
        .as_ref()
        .and_then(|status| status.load_balancer.as_ref())
        .and_then(|balancer| balancer.ingress.as_ref())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.ip
                        .clone()
                        .filter(|value| !value.is_empty())
                        .or_else(|| item.hostname.clone().filter(|value| !value.is_empty()))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn ingress_tls(ingress: &Ingress) -> String {
    ingress
        .spec
        .as_ref()
        .and_then(|spec| spec.tls.as_ref())
        .map(|items| {
            lines_of(items.iter().flat_map(|item| {
                item.hosts
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
            }))
        })
        .unwrap_or_default()
}

pub(crate) fn configmap_row(item: &ConfigMap) -> ResourceRow {
    let mut keys = Vec::new();
    if let Some(data) = &item.data {
        keys.extend(data.keys().cloned());
    }
    if let Some(data) = &item.binary_data {
        keys.extend(data.keys().cloned());
    }
    keys.sort();
    let count = keys.len();
    let mut row = make_row(
        &item.metadata,
        "Active".to_string(),
        StatusTone::Neutral,
        count.to_string(),
        if keys.is_empty() {
            "empty".to_string()
        } else {
            keys.join(", ")
        },
        None,
        None,
    );
    cell(&mut row, "keyList", lines_of(keys));
    row
}

pub(crate) fn secret_row(item: &Secret) -> ResourceRow {
    let mut keys = Vec::new();
    if let Some(data) = &item.data {
        keys.extend(data.keys().cloned());
    }
    if let Some(data) = &item.string_data {
        keys.extend(data.keys().cloned());
    }
    keys.sort();
    let ty = item.type_.clone().unwrap_or_else(|| "Opaque".to_string());
    let mut row = make_row(
        &item.metadata,
        ty,
        StatusTone::Neutral,
        keys.len().to_string(),
        if keys.is_empty() {
            "no keys".to_string()
        } else {
            keys.join(", ")
        },
        None,
        None,
    );
    cell(&mut row, "keyList", lines_of(keys));
    row
}

pub(crate) fn pod_usage(metrics: &PodMetrics) -> Option<UsageSample> {
    let name = metrics.metadata.name.clone()?;
    let namespace = metrics.metadata.namespace.clone().unwrap_or_default();
    let (cpu_millis, mem_bytes) =
        sum_usage(metrics.containers.iter().map(|container| &container.usage));
    Some(UsageSample {
        namespace,
        name,
        cpu_millis,
        mem_bytes,
    })
}

pub(crate) fn node_usage(metrics: &NodeMetrics) -> Option<UsageSample> {
    let name = metrics.metadata.name.clone()?;
    let (cpu_millis, mem_bytes) = sum_quantities(&metrics.usage);
    Some(UsageSample {
        namespace: String::new(),
        name,
        cpu_millis,
        mem_bytes,
    })
}

pub(crate) fn node_is_ready(node: &Node) -> bool {
    matches!(node_status(node).1, StatusTone::Ok)
}

pub(crate) fn replicaset_row(item: &ReplicaSet) -> ResourceRow {
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(0);
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let (status, tone, ready_col) = replica_status(ready, desired);
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        ready_col,
        String::new(),
        None,
        None,
    );
    cell(
        &mut row,
        "images",
        template_images(
            item.spec
                .as_ref()
                .and_then(|spec| spec.template.as_ref())
                .and_then(|template| template.spec.as_ref()),
        ),
    );
    row
}

pub(crate) fn cronjob_row(item: &CronJob) -> ResourceRow {
    let suspended = item.spec.suspend.unwrap_or(false);
    let active = item
        .status
        .as_ref()
        .and_then(|status| status.active.as_ref())
        .map(|jobs| jobs.len())
        .unwrap_or(0);
    let (status, tone) = if suspended {
        ("Suspended".to_string(), StatusTone::Warn)
    } else {
        ("Active".to_string(), StatusTone::Ok)
    };
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        active.to_string(),
        item.spec.schedule.clone(),
        None,
        None,
    );
    cell(
        &mut row,
        "concurrency",
        item.spec.concurrency_policy.clone().unwrap_or_default(),
    );
    cell(
        &mut row,
        "lastSchedule",
        item.status
            .as_ref()
            .and_then(|status| status.last_schedule_time.as_ref())
            .map(time_text)
            .unwrap_or_default(),
    );
    cell(
        &mut row,
        "images",
        template_images(
            item.spec
                .job_template
                .spec
                .as_ref()
                .and_then(|spec| spec.template.spec.as_ref()),
        ),
    );
    row
}

pub(crate) fn endpoints_row(item: &Endpoints) -> ResourceRow {
    let mut ready = 0usize;
    let mut not_ready = 0usize;
    if let Some(subsets) = &item.subsets {
        for subset in subsets {
            ready += subset
                .addresses
                .as_ref()
                .map(|addrs| addrs.len())
                .unwrap_or(0);
            not_ready += subset
                .not_ready_addresses
                .as_ref()
                .map(|addrs| addrs.len())
                .unwrap_or(0);
        }
    }
    let (status, tone) = if ready > 0 {
        ("Ready".to_string(), StatusTone::Ok)
    } else {
        ("NotReady".to_string(), StatusTone::Warn)
    };
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        ready.to_string(),
        format!("{not_ready} not ready"),
        None,
        None,
    );
    cell(&mut row, "ports", endpoint_ports(item));
    row
}

fn endpoint_ports(item: &Endpoints) -> String {
    let Some(subsets) = &item.subsets else {
        return String::new();
    };
    let mut ports = Vec::new();
    for subset in subsets {
        let Some(items) = &subset.ports else {
            continue;
        };
        for port in items {
            let proto = port.protocol.as_deref().unwrap_or("TCP");
            let name = port.name.clone().unwrap_or_default();
            ports.push(if name.is_empty() {
                format!("{}/{}", port.port, proto)
            } else {
                format!("{name} {}/{}", port.port, proto)
            });
        }
    }
    lines_of(ports)
}

pub(crate) fn endpointslice_row(item: &EndpointSlice) -> ResourceRow {
    let count = item
        .endpoints
        .as_ref()
        .map(|endpoints| endpoints.len())
        .unwrap_or(0);
    let mut row = make_row(
        &item.metadata,
        item.address_type.clone(),
        StatusTone::Neutral,
        count.to_string(),
        String::new(),
        None,
        None,
    );
    cell(&mut row, "ports", slice_ports(item));
    row
}

fn slice_ports(item: &EndpointSlice) -> String {
    let Some(ports) = &item.ports else {
        return String::new();
    };
    lines_of(ports.iter().map(|port| {
        let proto = port.protocol.as_deref().unwrap_or("TCP");
        let name = port.name.clone().unwrap_or_default();
        let number = port.port.map(|value| value.to_string()).unwrap_or_default();
        if name.is_empty() {
            format!("{number}/{proto}")
        } else {
            format!("{name} {number}/{proto}")
        }
    }))
}

pub(crate) fn networkpolicy_row(item: &NetworkPolicy) -> ResourceRow {
    let types = item
        .spec
        .as_ref()
        .and_then(|spec| spec.policy_types.clone())
        .unwrap_or_default()
        .join(", ");
    let (ingress, egress) = item
        .spec
        .as_ref()
        .map(|spec| {
            (
                spec.ingress.as_ref().map(|rules| rules.len()).unwrap_or(0),
                spec.egress.as_ref().map(|rules| rules.len()).unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    let mut row = make_row(
        &item.metadata,
        "Active".to_string(),
        StatusTone::Ok,
        if types.is_empty() {
            "-".to_string()
        } else {
            types
        },
        format!("{ingress} ingress · {egress} egress"),
        None,
        None,
    );
    if let Some(selector) = item.spec.as_ref().and_then(|spec| spec.pod_selector.as_ref()) {
        cell(&mut row, "selector", label_selector(selector));
    }
    row
}

pub(crate) fn ingressclass_row(item: &IngressClass) -> ResourceRow {
    let controller = item
        .spec
        .as_ref()
        .and_then(|spec| spec.controller.clone())
        .unwrap_or_else(|| "-".to_string());
    make_row(
        &item.metadata,
        "Active".to_string(),
        StatusTone::Neutral,
        controller,
        String::new(),
        None,
        None,
    )
}

pub(crate) fn resourcequota_row(item: &ResourceQuota) -> ResourceRow {
    let hard = item.status.as_ref().and_then(|status| status.hard.as_ref());
    let used = item
        .status
        .as_ref()
        .and_then(|status| status.used.as_ref())
        .map(|used| used.len())
        .unwrap_or(0);
    let hard_n = hard.map(|hard| hard.len()).unwrap_or(0);
    let keys = hard
        .map(|hard| {
            let mut keys: Vec<_> = hard.keys().cloned().collect();
            keys.sort();
            truncate(&keys.join(", "), 48)
        })
        .unwrap_or_default();
    make_row(
        &item.metadata,
        "Active".to_string(),
        StatusTone::Ok,
        format!("{used}/{hard_n}"),
        keys,
        None,
        None,
    )
}

pub(crate) fn limitrange_row(item: &LimitRange) -> ResourceRow {
    let limits = item.spec.as_ref().map(|spec| &spec.limits);
    let count = limits.map(|limits| limits.len()).unwrap_or(0);
    let types = limits
        .map(|limits| {
            let mut types: Vec<_> = limits.iter().map(|limit| limit.type_.clone()).collect();
            types.sort();
            types.dedup();
            types.join(", ")
        })
        .unwrap_or_default();
    make_row(
        &item.metadata,
        "Active".to_string(),
        StatusTone::Neutral,
        count.to_string(),
        types,
        None,
        None,
    )
}

pub(crate) fn hpa_row(item: &HorizontalPodAutoscaler) -> ResourceRow {
    let target = format!(
        "{}/{}",
        item.spec.scale_target_ref.kind, item.spec.scale_target_ref.name
    );
    let min = item.spec.min_replicas.unwrap_or(1);
    let max = item.spec.max_replicas;
    let current = item
        .status
        .as_ref()
        .and_then(|status| status.current_replicas)
        .unwrap_or(0);
    let desired = item
        .status
        .as_ref()
        .map(|status| status.desired_replicas)
        .unwrap_or(0);
    let (status, tone, ready_col) = replica_status(current, desired);
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        ready_col,
        format!("{target}  {min}–{max}"),
        None,
        None,
    );
    cell(&mut row, "min", min.to_string());
    cell(&mut row, "max", max.to_string());
    row
}

pub(crate) fn pdb_row(item: &PodDisruptionBudget) -> ResourceRow {
    let healthy = item
        .status
        .as_ref()
        .and_then(|status| status.current_healthy)
        .unwrap_or(0);
    let desired = item
        .status
        .as_ref()
        .and_then(|status| status.desired_healthy)
        .unwrap_or(0);
    let allowed = item
        .status
        .as_ref()
        .and_then(|status| status.disruptions_allowed)
        .unwrap_or(0);
    let budget = item
        .spec
        .as_ref()
        .and_then(|spec| {
            spec.min_available
                .as_ref()
                .map(|value| format!("min {}", int_or_string(value)))
                .or_else(|| {
                    spec.max_unavailable
                        .as_ref()
                        .map(|value| format!("max {}", int_or_string(value)))
                })
        })
        .unwrap_or_default();
    let (status, tone, ready_col) = replica_status(healthy, desired);
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        ready_col,
        format!("{budget} · {allowed} allowed"),
        None,
        None,
    );
    cell(&mut row, "allowed", allowed.to_string());
    if let Some(selector) = item.spec.as_ref().and_then(|spec| spec.selector.as_ref()) {
        cell(&mut row, "selector", label_selector(selector));
    }
    row
}

pub(crate) fn pvc_row(item: &PersistentVolumeClaim) -> ResourceRow {
    let phase = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());
    let storage = item
        .spec
        .as_ref()
        .and_then(|spec| spec.resources.as_ref())
        .and_then(|resources| resources.requests.as_ref())
        .map(storage_qty)
        .unwrap_or_else(|| "-".to_string());
    let class = item
        .spec
        .as_ref()
        .and_then(|spec| spec.storage_class_name.clone())
        .unwrap_or_default();
    let volume = item
        .spec
        .as_ref()
        .and_then(|spec| spec.volume_name.clone())
        .unwrap_or_default();
    let info = match (class.is_empty(), volume.is_empty()) {
        (false, false) => format!("{class} · {volume}"),
        (false, true) => class.clone(),
        (true, false) => volume.clone(),
        (true, true) => String::new(),
    };
    let mut row = make_row(
        &item.metadata,
        phase.clone(),
        phase_tone(&phase),
        storage,
        info,
        None,
        None,
    );
    cell(&mut row, "class", class);
    cell(&mut row, "volume", volume);
    cell(
        &mut row,
        "accessModes",
        item.spec
            .as_ref()
            .and_then(|spec| spec.access_modes.clone())
            .unwrap_or_default()
            .join(", "),
    );
    row
}

pub(crate) fn pv_row(item: &PersistentVolume) -> ResourceRow {
    let phase = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());
    let storage = item
        .spec
        .as_ref()
        .and_then(|spec| spec.capacity.as_ref())
        .map(storage_qty)
        .unwrap_or_else(|| "-".to_string());
    let class = item
        .spec
        .as_ref()
        .and_then(|spec| spec.storage_class_name.clone())
        .unwrap_or_default();
    let reclaim = item
        .spec
        .as_ref()
        .and_then(|spec| spec.persistent_volume_reclaim_policy.clone())
        .unwrap_or_default();
    let info = match (class.is_empty(), reclaim.is_empty()) {
        (false, false) => format!("{class} · {reclaim}"),
        (false, true) => class.clone(),
        (true, false) => reclaim.clone(),
        (true, true) => String::new(),
    };
    let mut row = make_row(
        &item.metadata,
        phase.clone(),
        phase_tone(&phase),
        storage,
        info,
        None,
        None,
    );
    cell(&mut row, "class", class);
    cell(&mut row, "reclaim", reclaim);
    cell(
        &mut row,
        "claim",
        item.spec
            .as_ref()
            .and_then(|spec| spec.claim_ref.as_ref())
            .and_then(|claim| {
                let name = claim.name.clone()?;
                Some(match claim.namespace.clone() {
                    Some(namespace) if !namespace.is_empty() => format!("{namespace}/{name}"),
                    _ => name,
                })
            })
            .unwrap_or_default(),
    );
    cell(
        &mut row,
        "accessModes",
        item.spec
            .as_ref()
            .and_then(|spec| spec.access_modes.clone())
            .unwrap_or_default()
            .join(", "),
    );
    row
}

pub(crate) fn storageclass_row(item: &StorageClass) -> ResourceRow {
    let mut row = make_row(
        &item.metadata,
        "Active".to_string(),
        StatusTone::Neutral,
        item.reclaim_policy
            .clone()
            .unwrap_or_else(|| "-".to_string()),
        item.provisioner.clone(),
        None,
        None,
    );
    cell(
        &mut row,
        "binding",
        item.volume_binding_mode.clone().unwrap_or_default(),
    );
    if let Some(expansion) = item.allow_volume_expansion {
        cell(&mut row, "expansion", expansion.to_string());
    }
    row
}

pub(crate) fn serviceaccount_row(item: &ServiceAccount) -> ResourceRow {
    let secrets = item
        .secrets
        .as_ref()
        .map(|secrets| secrets.len())
        .unwrap_or(0);
    let pulls = item
        .image_pull_secrets
        .as_ref()
        .map(|secrets| secrets.len())
        .unwrap_or(0);
    let mut row = make_row(
        &item.metadata,
        "Active".to_string(),
        StatusTone::Neutral,
        secrets.to_string(),
        format!("{pulls} pull secrets"),
        None,
        None,
    );
    cell(
        &mut row,
        "secretNames",
        lines_of(
            item.secrets
                .iter()
                .flatten()
                .filter_map(|secret| secret.name.clone()),
        ),
    );
    cell(
        &mut row,
        "pullNames",
        lines_of(
            item.image_pull_secrets
                .iter()
                .flatten()
                .map(|secret| secret.name.clone()),
        ),
    );
    row
}

pub(crate) fn role_row(item: &Role) -> ResourceRow {
    rules_row(&item.metadata, item.rules.as_deref())
}

pub(crate) fn clusterrole_row(item: &ClusterRole) -> ResourceRow {
    rules_row(&item.metadata, item.rules.as_deref())
}

pub(crate) fn rolebinding_row(item: &RoleBinding) -> ResourceRow {
    binding_row(
        &item.metadata,
        &item.role_ref.kind,
        &item.role_ref.name,
        item.subjects.as_deref(),
    )
}

pub(crate) fn clusterrolebinding_row(item: &ClusterRoleBinding) -> ResourceRow {
    binding_row(
        &item.metadata,
        &item.role_ref.kind,
        &item.role_ref.name,
        item.subjects.as_deref(),
    )
}

pub(crate) fn crd_row(item: &CustomResourceDefinition) -> ResourceRow {
    let established = item.status.as_ref().and_then(|status| {
        status
            .conditions
            .as_ref()
            .and_then(|conditions| {
                conditions
                    .iter()
                    .find(|condition| condition.type_ == "Established")
            })
            .map(|condition| condition.status.as_str())
    });
    let (status, tone) = match established {
        Some("True") => ("Established".to_string(), StatusTone::Ok),
        Some("False") => ("NotEstablished".to_string(), StatusTone::Bad),
        _ => ("Unknown".to_string(), StatusTone::Neutral),
    };
    let version = item
        .spec
        .versions
        .iter()
        .find(|version| version.storage)
        .map(|version| version.name.as_str())
        .unwrap_or("");
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        item.spec.scope.clone(),
        format!("{}/{}", item.spec.group, version),
        None,
        None,
    );
    cell(&mut row, "kind", item.spec.names.kind.clone());
    cell(
        &mut row,
        "versions",
        item.spec
            .versions
            .iter()
            .map(|version| version.name.clone())
            .collect::<Vec<_>>()
            .join(", "),
    );
    row
}

pub(crate) fn dynamic_row(item: &DynamicObject) -> ResourceRow {
    let (status, tone) = dynamic_status(&item.data);
    let mut row = make_row(
        &item.metadata,
        status,
        tone,
        "-".to_string(),
        String::new(),
        None,
        None,
    );
    let data = &item.data;
    cell(&mut row, "hostnames", json_strings(data, "/spec/hostnames"));
    cell(&mut row, "parent", json_names(data, "/spec/parentRefs"));
    cell(
        &mut row,
        "controller",
        json_string(data, "/spec/controller"),
    );
    cell(
        &mut row,
        "class",
        json_string(data, "/spec/gatewayClassName"),
    );
    cell(&mut row, "listeners", json_len(data, "/spec/listeners"));
    cell(&mut row, "listenerList", listener_lines(data));
    cell(
        &mut row,
        "addresses",
        json_names_key(data, "/status/addresses", "value"),
    );
    cell(&mut row, "backends", backend_names(data));
    cell(&mut row, "target", json_names(data, "/spec/targetRefs"));
    cell(
        &mut row,
        "hostname",
        json_string(data, "/spec/validation/hostname"),
    );
    cell(&mut row, "from", grant_from(data));
    cell(&mut row, "to", grant_to(data));
    cell(
        &mut row,
        "gateway",
        json_string(data, "/spec/parentRef/name"),
    );
    row
}

pub(crate) fn namespace_row(item: &Namespace) -> ResourceRow {
    let phase = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());
    make_row(
        &item.metadata,
        phase.clone(),
        phase_tone(&phase),
        phase,
        String::new(),
        None,
        None,
    )
}

fn rules_row(
    meta: &ObjectMeta,
    rules: Option<&[k8s_openapi::api::rbac::v1::PolicyRule]>,
) -> ResourceRow {
    let mut row = make_row(
        meta,
        "Active".to_string(),
        StatusTone::Neutral,
        rules.map(|rules| rules.len()).unwrap_or(0).to_string(),
        String::new(),
        None,
        None,
    );
    cell(&mut row, "ruleList", rule_lines(rules.unwrap_or(&[])));
    row
}

fn rule_lines(rules: &[k8s_openapi::api::rbac::v1::PolicyRule]) -> String {
    lines_of(rules.iter().map(|rule| {
        let resources = rule.resources.clone().unwrap_or_default();
        let resource = if resources.is_empty() {
            rule.non_resource_urls
                .clone()
                .unwrap_or_else(|| vec!["*".to_string()])
                .join(", ")
        } else {
            resources.join(", ")
        };
        format!("{resource}: {}", rule.verbs.join(", "))
    }))
}

fn binding_row(
    meta: &ObjectMeta,
    kind: &str,
    name: &str,
    subjects: Option<&[k8s_openapi::api::rbac::v1::Subject]>,
) -> ResourceRow {
    let mut row = make_row(
        meta,
        "Active".to_string(),
        StatusTone::Neutral,
        subjects.map(|subjects| subjects.len()).unwrap_or(0).to_string(),
        format!("{kind}/{name}"),
        None,
        None,
    );
    cell(
        &mut row,
        "subjectList",
        lines_of(subjects.unwrap_or(&[]).iter().map(|subject| {
            match subject.namespace.as_deref() {
                Some(namespace) if !namespace.is_empty() => {
                    format!("{}/{namespace}/{}", subject.kind, subject.name)
                }
                _ => format!("{}/{}", subject.kind, subject.name),
            }
        })),
    );
    row
}

fn cell(row: &mut ResourceRow, key: &str, value: impl Into<String>) {
    let value = value.into();
    if !value.is_empty() && value != "-" {
        row.cells.insert(key.to_string(), value);
    }
}

fn json_string(data: &serde_json::Value, pointer: &str) -> String {
    data.pointer(pointer)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

fn json_strings(data: &serde_json::Value, pointer: &str) -> String {
    data.pointer(pointer)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn json_names(data: &serde_json::Value, pointer: &str) -> String {
    json_names_key(data, pointer, "name")
}

fn json_names_key(data: &serde_json::Value, pointer: &str, key: &str) -> String {
    data.pointer(pointer)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get(key).and_then(|name| name.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn json_len(data: &serde_json::Value, pointer: &str) -> String {
    data.pointer(pointer)
        .and_then(|value| value.as_array())
        .map(|items| items.len().to_string())
        .unwrap_or_default()
}

fn backend_names(data: &serde_json::Value) -> String {
    let Some(rules) = data
        .pointer("/spec/rules")
        .and_then(|value| value.as_array())
    else {
        return String::new();
    };
    let mut names = Vec::new();
    for rule in rules {
        if let Some(refs) = rule.get("backendRefs").and_then(|value| value.as_array()) {
            for backend in refs {
                if let Some(name) = backend.get("name").and_then(|name| name.as_str()) {
                    names.push(name);
                }
            }
        }
    }
    names.join(", ")
}

fn grant_from(data: &serde_json::Value) -> String {
    let Some(items) = data
        .pointer("/spec/from")
        .and_then(|value| value.as_array())
    else {
        return String::new();
    };
    items
        .iter()
        .map(|item| {
            let kind = item
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let namespace = item
                .get("namespace")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            format!("{kind} in {namespace}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn grant_to(data: &serde_json::Value) -> String {
    let Some(items) = data.pointer("/spec/to").and_then(|value| value.as_array()) else {
        return String::new();
    };
    items
        .iter()
        .map(|item| {
            let kind = item
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let name = item
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("*");
            format!("{kind}/{name}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn dynamic_status(data: &serde_json::Value) -> (String, StatusTone) {
    let status = data.get("status");
    if let Some(phase) = status
        .and_then(|status| status.get("phase"))
        .and_then(|phase| phase.as_str())
    {
        return (phase.to_string(), phase_tone(phase));
    }
    if let Some(conditions) = status
        .and_then(|status| status.get("conditions"))
        .and_then(|conditions| conditions.as_array())
    {
        let condition = conditions
            .iter()
            .find(|condition| condition.get("type").and_then(|ty| ty.as_str()) == Some("Ready"))
            .or_else(|| conditions.first());
        if let Some(condition) = condition {
            let ty = condition
                .get("type")
                .and_then(|ty| ty.as_str())
                .unwrap_or("Unknown");
            let state = condition
                .get("status")
                .and_then(|state| state.as_str())
                .unwrap_or("Unknown");
            let tone = match state {
                "True" => StatusTone::Ok,
                "False" => StatusTone::Bad,
                _ => StatusTone::Warn,
            };
            return (format!("{ty} {state}"), tone);
        }
    }
    ("Active".to_string(), StatusTone::Neutral)
}

fn phase_tone(phase: &str) -> StatusTone {
    match phase {
        "Active" | "Bound" | "Available" | "Ready" | "Running" => StatusTone::Ok,
        "Pending" | "Released" | "Terminating" => StatusTone::Warn,
        "Failed" | "Lost" => StatusTone::Bad,
        _ => StatusTone::Neutral,
    }
}

fn int_or_string(value: &IntOrString) -> String {
    match value {
        IntOrString::Int(number) => number.to_string(),
        IntOrString::String(text) => text.clone(),
    }
}

fn storage_qty(map: &BTreeMap<String, Quantity>) -> String {
    map.get("storage")
        .map(|qty| qty_str(qty).to_string())
        .unwrap_or_else(|| "-".to_string())
}

fn make_row(
    meta: &ObjectMeta,
    mut status: String,
    mut tone: StatusTone,
    ready: String,
    info: String,
    cpu_request_millis: Option<f64>,
    mem_request_bytes: Option<f64>,
) -> ResourceRow {
    if meta.deletion_timestamp.is_some() {
        status = "Terminating".to_string();
        tone = StatusTone::Warn;
    }
    let name = meta.name.clone().unwrap_or_default();
    let namespace = meta.namespace.clone().unwrap_or_default();
    let uid = meta
        .uid
        .clone()
        .unwrap_or_else(|| format!("{namespace}/{name}"));
    let mut cells = BTreeMap::new();
    let controlled = controlled_by(meta);
    if !controlled.is_empty() {
        cells.insert("controlledBy".to_string(), controlled);
    }
    let managed = argo_application(meta);
    if !managed.is_empty() {
        cells.insert("managedBy".to_string(), managed);
    }
    ResourceRow {
        uid,
        name,
        namespace,
        status,
        tone,
        ready,
        age_secs: meta_age(meta),
        info,
        cells,
        labels: labels_of(meta),
        annotations: annotations_of(meta),
        cpu_millis: None,
        cpu_request_millis,
        mem_bytes: None,
        mem_request_bytes,
    }
}

fn argo_application(meta: &ObjectMeta) -> String {
    if let Some(name) = meta
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get("argocd.argoproj.io/tracking-id"))
        .and_then(|value| value.split(':').next())
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    let labels = meta.labels.as_ref();
    let helm = labels
        .and_then(|labels| labels.get("app.kubernetes.io/managed-by"))
        .is_some_and(|value| value.eq_ignore_ascii_case("helm"));
    if helm {
        return String::new();
    }
    labels
        .and_then(|labels| labels.get("app.kubernetes.io/instance"))
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn controlled_by(meta: &ObjectMeta) -> String {
    let owners = meta.owner_references.as_deref().unwrap_or(&[]);
    let controllers: Vec<_> = owners
        .iter()
        .filter(|owner| owner.controller == Some(true))
        .collect();
    let chosen: Vec<_> = if controllers.is_empty() {
        owners.iter().collect()
    } else {
        controllers
    };
    if !chosen.is_empty() {
        return chosen
            .into_iter()
            .map(|owner| format!("{}/{}", owner.kind, owner.name))
            .collect::<Vec<_>>()
            .join(", ");
    }
    meta.labels
        .as_ref()
        .and_then(|labels| labels.get("app.kubernetes.io/managed-by"))
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn images_of(containers: &[k8s_openapi::api::core::v1::Container]) -> String {
    containers
        .iter()
        .filter_map(|container| container.image.clone())
        .filter(|image| !image.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn template_images(spec: Option<&k8s_openapi::api::core::v1::PodSpec>) -> String {
    spec.map(|spec| images_of(&spec.containers))
        .unwrap_or_default()
}

fn selector_line(selector: &BTreeMap<String, String>) -> String {
    let mut pairs: Vec<_> = selector
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect();
    pairs.sort();
    pairs.join(", ")
}

fn label_selector(selector: &k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector) -> String {
    let mut parts = Vec::new();
    if let Some(labels) = &selector.match_labels {
        let mut pairs: Vec<_> = labels
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        pairs.sort();
        parts.extend(pairs);
    }
    if let Some(expressions) = &selector.match_expressions {
        for expression in expressions {
            let values = expression.values.clone().unwrap_or_default();
            if values.is_empty() {
                parts.push(format!("{} {}", expression.key, expression.operator));
            } else {
                parts.push(format!(
                    "{} {} {}",
                    expression.key,
                    expression.operator,
                    values.join(",")
                ));
            }
        }
    }
    parts.join(", ")
}

fn lines_of(items: impl IntoIterator<Item = String>) -> String {
    items
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn labels_of(meta: &ObjectMeta) -> Vec<(String, String)> {
    pairs_of(meta.labels.as_ref(), |_| true)
}

fn annotations_of(meta: &ObjectMeta) -> Vec<(String, String)> {
    pairs_of(meta.annotations.as_ref(), |key| {
        key != "kubectl.kubernetes.io/last-applied-configuration"
    })
}

fn pairs_of(
    map: Option<&BTreeMap<String, String>>,
    keep: impl Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut pairs: Vec<_> = map
        .into_iter()
        .flatten()
        .filter(|(key, _)| keep(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    pairs.sort();
    pairs
}

fn listener_lines(data: &serde_json::Value) -> String {
    let Some(items) = data
        .pointer("/spec/listeners")
        .and_then(|value| value.as_array())
    else {
        return String::new();
    };
    items
        .iter()
        .filter_map(listener_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn listener_line(item: &serde_json::Value) -> Option<String> {
    let name = item.get("name").and_then(|value| value.as_str()).unwrap_or("");
    let protocol = item
        .get("protocol")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let port = match item.get("port") {
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(serde_json::Value::String(text)) => text.clone(),
        _ => String::new(),
    };
    let hostname = item
        .get("hostname")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if name.is_empty() && protocol.is_empty() && port.is_empty() && hostname.is_empty() {
        None
    } else {
        Some(format!("{name}\t{protocol}\t{port}\t{hostname}"))
    }
}

fn meta_age(meta: &ObjectMeta) -> u64 {
    meta.creation_timestamp.as_ref().map(time_age).unwrap_or(0)
}

fn time_text(ts: &Time) -> String {
    ts.0.to_string()
}

fn time_age(ts: &Time) -> u64 {
    let then = ts.0.as_second();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    now.saturating_sub(then).max(0) as u64
}

fn pod_status(pod: &Pod) -> (String, StatusTone) {
    if let Some(status) = &pod.status {
        if let Some(statuses) = &status.container_statuses {
            for container in statuses {
                if let Some(reason) = container
                    .state
                    .as_ref()
                    .and_then(|state| state.waiting.as_ref())
                    .and_then(|waiting| waiting.reason.clone())
                {
                    let tone = match reason.as_str() {
                        "ContainerCreating" | "PodInitializing" => StatusTone::Warn,
                        _ => StatusTone::Bad,
                    };
                    return (reason, tone);
                }
            }
        }
        if let Some(phase) = &status.phase {
            let tone = match phase.as_str() {
                "Running" | "Succeeded" => StatusTone::Ok,
                "Pending" => StatusTone::Warn,
                "Failed" | "Unknown" => StatusTone::Bad,
                _ => StatusTone::Neutral,
            };
            return (phase.clone(), tone);
        }
    }
    ("Unknown".to_string(), StatusTone::Neutral)
}

fn pod_ready(pod: &Pod) -> String {
    match pod
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
    {
        Some(statuses) if !statuses.is_empty() => {
            let ready = statuses.iter().filter(|container| container.ready).count();
            format!("{ready}/{}", statuses.len())
        }
        _ => "-".to_string(),
    }
}

fn pod_requests(pod: &Pod) -> (Option<f64>, Option<f64>) {
    let mut cpu = 0.0;
    let mut mem = 0.0;
    let mut any_cpu = false;
    let mut any_mem = false;
    let Some(spec) = &pod.spec else {
        return (None, None);
    };
    for container in &spec.containers {
        let Some(requests) = container
            .resources
            .as_ref()
            .and_then(|res| res.requests.as_ref())
        else {
            continue;
        };
        if let Some(value) = requests
            .get("cpu")
            .and_then(|qty| parse_cpu_millis(qty_str(qty)))
        {
            cpu += value;
            any_cpu = true;
        }
        if let Some(value) = requests
            .get("memory")
            .and_then(|qty| parse_bytes(qty_str(qty)))
        {
            mem += value;
            any_mem = true;
        }
    }
    (any_cpu.then_some(cpu), any_mem.then_some(mem))
}

fn node_status(node: &Node) -> (String, StatusTone) {
    let ready = node
        .status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .and_then(|conditions| {
            conditions
                .iter()
                .find(|condition| condition.type_ == "Ready")
                .map(|condition| condition.status.as_str())
        });
    match ready {
        Some("True") => ("Ready".to_string(), StatusTone::Ok),
        Some("False") => ("NotReady".to_string(), StatusTone::Bad),
        Some(_) => ("Unknown".to_string(), StatusTone::Warn),
        None => ("Unknown".to_string(), StatusTone::Neutral),
    }
}

fn node_roles(node: &Node) -> String {
    let mut roles = Vec::new();
    if let Some(labels) = &node.metadata.labels {
        for key in labels.keys() {
            if let Some(role) = key.strip_prefix("node-role.kubernetes.io/") {
                if !role.is_empty() {
                    roles.push(role.to_string());
                }
            }
        }
    }
    roles.sort();
    if roles.is_empty() {
        "worker".to_string()
    } else {
        roles.join(", ")
    }
}

fn node_allocatable(node: &Node) -> (Option<f64>, Option<f64>) {
    let Some(allocatable) = node
        .status
        .as_ref()
        .and_then(|status| status.allocatable.as_ref())
    else {
        return (None, None);
    };
    (
        allocatable
            .get("cpu")
            .and_then(|qty| parse_cpu_millis(qty_str(qty))),
        allocatable
            .get("memory")
            .and_then(|qty| parse_bytes(qty_str(qty))),
    )
}

fn replica_status(ready: i32, desired: i32) -> (String, StatusTone, String) {
    let column = format!("{ready}/{desired}");
    if desired == 0 {
        ("Scaled to 0".to_string(), StatusTone::Neutral, column)
    } else if ready >= desired {
        ("Ready".to_string(), StatusTone::Ok, column)
    } else if ready == 0 {
        ("Unavailable".to_string(), StatusTone::Bad, column)
    } else {
        ("Progressing".to_string(), StatusTone::Warn, column)
    }
}

fn sum_usage<'a>(maps: impl Iterator<Item = &'a BTreeMap<String, Quantity>>) -> (f64, f64) {
    let mut cpu = 0.0;
    let mut mem = 0.0;
    for usage in maps {
        let (cpu_part, mem_part) = sum_quantities(usage);
        cpu += cpu_part;
        mem += mem_part;
    }
    (cpu, mem)
}

fn sum_quantities(usage: &BTreeMap<String, Quantity>) -> (f64, f64) {
    let cpu = usage
        .get("cpu")
        .and_then(|qty| parse_cpu_millis(qty_str(qty)))
        .unwrap_or(0.0);
    let mem = usage
        .get("memory")
        .and_then(|qty| parse_bytes(qty_str(qty)))
        .unwrap_or(0.0);
    (cpu, mem)
}

fn qty_str(qty: &Quantity) -> &str {
    qty.0.as_str()
}

fn truncate(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        text.to_string()
    } else {
        let trimmed: String = text.chars().take(max_chars).collect();
        format!("{trimmed}…")
    }
}
