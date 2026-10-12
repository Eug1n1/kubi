use std::path::{Path, PathBuf};

use kubi_core::{Command, CoreHandle, CoreSender};
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let core = CoreHandle::spawn();
            app.manage(core.command_sender());
            std::thread::Builder::new()
                .name("kubi-events".into())
                .spawn(move || {
                    while let Some(event) = core.recv() {
                        let _ = handle.emit("kubi", &event);
                    }
                })
                .expect("kubi event thread");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_command,
            load_context_groups,
            save_context_groups
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kubi");
}

#[tauri::command]
fn send_command(sender: tauri::State<'_, CoreSender>, command: Command) {
    sender.send(command);
}

/// The context rail folders live in the app config directory, so they survive
/// both dev runs and bundled builds.
fn groups_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("context-groups.json"))
        .map_err(|err| format!("config dir: {err}"))
}

/// Stored JSON, or `None` before the first save.
fn read_groups(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("read {}: {err}", path.display())),
    }
}

/// Replaced through a temporary file so a crash cannot truncate the layout.
fn write_groups(path: &Path, data: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("create {}: {err}", dir.display()))?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, data).map_err(|err| format!("write {}: {err}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|err| format!("replace {}: {err}", path.display()))
}

#[tauri::command]
fn load_context_groups(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_groups(&groups_file(&app)?)
}

#[tauri::command]
fn save_context_groups(app: tauri::AppHandle, data: String) -> Result<(), String> {
    write_groups(&groups_file(&app)?, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kubi-groups-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_reads_as_none() {
        let dir = temp_dir("missing");
        assert!(read_groups(&dir.join("context-groups.json")).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_then_reads_and_leaves_no_temp_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("context-groups.json");
        let data = r#"{"version":1,"groups":[{"id":"g1","name":"kz","contexts":["kz-mgmt"]}]}"#;
        write_groups(&path, data).unwrap();
        assert_eq!(read_groups(&path).unwrap().as_deref(), Some(data));
        assert!(!path.with_extension("json.tmp").exists());
        write_groups(&path, "{}").unwrap();
        assert_eq!(read_groups(&path).unwrap().as_deref(), Some("{}"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
