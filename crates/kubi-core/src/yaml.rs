use serde_json::{Map, Value};

/// Read-only YAML for the detail panel. `mask_secret` replaces Secret `data` / `stringData`.
pub fn object_to_yaml(
    mut value: Value,
    api_version: &str,
    kind: &str,
    mask_secret: bool,
) -> Result<String, String> {
    if let Some(meta) = value.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
    }
    if mask_secret {
        mask_map(value.get_mut("data"));
        mask_map(value.get_mut("stringData"));
    }

    let mut ordered = Map::new();
    ordered.insert(
        "apiVersion".to_string(),
        Value::String(api_version.to_string()),
    );
    ordered.insert("kind".to_string(), Value::String(kind.to_string()));
    if let Some(obj) = value.as_object() {
        for (key, item) in obj {
            if key == "apiVersion" || key == "kind" {
                continue;
            }
            ordered.insert(key.clone(), item.clone());
        }
    }
    serde_yaml::to_string(&Value::Object(ordered)).map_err(|err| err.to_string())
}

fn mask_map(slot: Option<&mut Value>) {
    let Some(Value::Object(map)) = slot else {
        return;
    };
    for value in map.values_mut() {
        *value = Value::String("*****".to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn masks_secret_and_strips_managed_fields() {
        let value = json!({
            "metadata": {"name": "db", "managedFields": [{"manager": "kubectl"}]},
            "data": {"password": "c2VjcmV0"},
            "stringData": {"token": "abc"}
        });
        let yaml = object_to_yaml(value, "v1", "Secret", true).unwrap();
        assert!(yaml.contains("apiVersion: v1"));
        assert!(yaml.contains("kind: Secret"));
        assert!(yaml.contains("*****"));
        assert!(!yaml.contains("c2VjcmV0"));
        assert!(!yaml.contains("abc"));
        assert!(!yaml.contains("managedFields"));
    }

    #[test]
    fn reveal_keeps_secret_data() {
        let value = json!({"data": {"password": "c2VjcmV0"}});
        let yaml = object_to_yaml(value, "v1", "Secret", false).unwrap();
        assert!(yaml.contains("c2VjcmV0"));
    }
}
