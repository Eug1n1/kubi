use std::borrow::Cow;
use std::collections::BTreeMap;

use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use k8s_openapi::{ClusterResourceScope, NamespaceResourceScope};
use kube::Resource;
use serde::{Deserialize, Serialize};

/// `metrics.k8s.io/v1beta1` is not shipped in k8s-openapi, so the two list types live here.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PodMetrics {
    #[serde(default)]
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub containers: Vec<ContainerMetrics>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ContainerMetrics {
    pub name: String,
    #[serde(default)]
    pub usage: BTreeMap<String, Quantity>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NodeMetrics {
    #[serde(default)]
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub usage: BTreeMap<String, Quantity>,
}

impl Resource for PodMetrics {
    type DynamicType = ();
    type Scope = NamespaceResourceScope;

    fn kind(_: &()) -> Cow<'_, str> {
        "PodMetrics".into()
    }

    fn group(_: &()) -> Cow<'_, str> {
        "metrics.k8s.io".into()
    }

    fn version(_: &()) -> Cow<'_, str> {
        "v1beta1".into()
    }

    fn plural(_: &()) -> Cow<'_, str> {
        "pods".into()
    }

    fn meta(&self) -> &ObjectMeta {
        &self.metadata
    }

    fn meta_mut(&mut self) -> &mut ObjectMeta {
        &mut self.metadata
    }
}

impl Resource for NodeMetrics {
    type DynamicType = ();
    type Scope = ClusterResourceScope;

    fn kind(_: &()) -> Cow<'_, str> {
        "NodeMetrics".into()
    }

    fn group(_: &()) -> Cow<'_, str> {
        "metrics.k8s.io".into()
    }

    fn version(_: &()) -> Cow<'_, str> {
        "v1beta1".into()
    }

    fn plural(_: &()) -> Cow<'_, str> {
        "nodes".into()
    }

    fn meta(&self) -> &ObjectMeta {
        &self.metadata
    }

    fn meta_mut(&mut self) -> &mut ObjectMeta {
        &mut self.metadata
    }
}
