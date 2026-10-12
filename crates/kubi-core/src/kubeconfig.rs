use std::path::Path;

use kube::config::{Kubeconfig, NamedContext};

use crate::model::ContextInfo;

pub fn load_kubeconfig(path: Option<&Path>) -> Result<Kubeconfig, String> {
    match path {
        Some(path) => {
            Kubeconfig::read_from(path).map_err(|err| format!("read {}: {err}", path.display()))
        }
        None => Kubeconfig::read().map_err(|err| format!("read kubeconfig: {err}")),
    }
}

pub fn contexts_from(kubeconfig: &Kubeconfig) -> Vec<ContextInfo> {
    let current = kubeconfig.current_context.as_deref();
    kubeconfig
        .contexts
        .iter()
        .map(|named| context_info(named, current))
        .collect()
}

pub fn namespace_of(kubeconfig: &Kubeconfig, context: &str) -> Option<String> {
    kubeconfig
        .contexts
        .iter()
        .find(|named| named.name == context)
        .and_then(|named| named.context.as_ref())
        .and_then(|ctx| ctx.namespace.clone())
        .filter(|ns| !ns.is_empty())
}

fn context_info(named: &NamedContext, current: Option<&str>) -> ContextInfo {
    let (cluster, namespace) = named
        .context
        .as_ref()
        .map(|ctx| (ctx.cluster.clone(), ctx.namespace.clone()))
        .unwrap_or_else(|| (String::new(), None));
    ContextInfo {
        name: named.name.clone(),
        cluster,
        namespace: namespace.filter(|ns| !ns.is_empty()),
        current: current == Some(named.name.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_contexts_from_a_file() {
        let path = std::env::temp_dir().join(format!("kubi-kubeconfig-{}", std::process::id()));
        std::fs::write(
            &path,
            r#"
apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev-cluster
  cluster:
    server: https://127.0.0.1:6443
users:
- name: dev-user
  user:
    token: fake-token
contexts:
- name: dev
  context:
    cluster: dev-cluster
    user: dev-user
    namespace: apps
- name: prod
  context:
    cluster: dev-cluster
    user: dev-user
"#,
        )
        .unwrap();

        let kc = load_kubeconfig(Some(&path)).unwrap();
        let contexts = contexts_from(&kc);
        assert_eq!(contexts.len(), 2);
        assert!(contexts[0].current);
        assert_eq!(contexts[0].name, "dev");
        assert_eq!(contexts[0].cluster, "dev-cluster");
        assert_eq!(contexts[0].namespace.as_deref(), Some("apps"));
        assert!(!contexts[1].current);
        assert_eq!(namespace_of(&kc, "dev").as_deref(), Some("apps"));
        assert_eq!(namespace_of(&kc, "prod"), None);
        let _ = std::fs::remove_file(path);
    }
}
