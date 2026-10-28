use std::path::{Path, PathBuf};

use kubi_core::{Command, CoreHandle, CoreSender};
use tauri::{Emitter, Manager};

/// GUI launches (Finder, Start menu) hand the process a minimal PATH, so a
/// kube exec credential plugin (`kubelogin`, `aws-iam-authenticator`,
/// `gke-gcloud-auth-plugin`, a custom helper…) named by the kubeconfig is not
/// found: "unable to run auth exec: No such file or directory (os error 2)".
/// Add the usual binary locations before running so kubectl's plugins keep
/// working outside a shell. Anything already on PATH stays where it is.
fn extend_path_for_exec_plugins() -> String {
    let separator = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };
    let sep = separator.to_string();
    let current = std::env::var("PATH").unwrap_or_default();
    let already: Vec<&str> = current.split(separator).filter(|s| !s.is_empty()).collect();
    let mut extra: Vec<String> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        extra.push("/opt/homebrew/bin".into());
        extra.push("/usr/local/bin".into());
    }
    #[cfg(target_os = "linux")]
    {
        extra.push("/usr/local/bin".into());
    }
    if let Ok(home) = std::env::var("HOME") {
        extra.push(format!("{home}/bin"));
    }
    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            extra.push(format!("{home}\\bin"));
        }
    }
    let mut added = Vec::new();
    for dir in extra {
        if std::path::Path::new(&dir).is_dir() && !already.iter().any(|old| old == &dir) {
            added.push(dir);
        }
    }
    if added.is_empty() {
        return current;
    }
    let mut next = added.join(&sep);
    next.push(separator);
    next.push_str(&current);
    next
}

fn main() {
    // Give kube exec auth plugins a PATH that kubectl users expect. When
    // nothing is added this is the current PATH, so the set_var is a no-op.
    std::env::set_var("PATH", extend_path_for_exec_plugins());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // The updater is desktop-only: it ships no mobile code and its
            // target detection assumes a desktop bundle layout.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
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
            save_context_groups,
            load_settings,
            save_settings,
            load_themes,
            save_themes,
            load_theme_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kubi");
}

#[tauri::command]
fn send_command(sender: tauri::State<'_, CoreSender>, command: Command) {
    sender.send(command);
}

/// UI state lives in the app config directory, so it survives both dev runs and
/// bundled builds.
fn config_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(name))
        .map_err(|err| format!("config dir: {err}"))
}

/// Stored JSON, or `None` before the first save.
fn read_config(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("read {}: {err}", path.display())),
    }
}

/// Replaced through a temporary file so a crash cannot truncate the contents.
fn write_config(path: &Path, data: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("create {}: {err}", dir.display()))?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, data).map_err(|err| format!("write {}: {err}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|err| format!("replace {}: {err}", path.display()))
}

#[tauri::command]
fn load_context_groups(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_config(&config_file(&app, "context-groups.json")?)
}

#[tauri::command]
fn save_context_groups(app: tauri::AppHandle, data: String) -> Result<(), String> {
    write_config(&config_file(&app, "context-groups.json")?, &data)
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_config(&config_file(&app, "settings.json")?)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, data: String) -> Result<(), String> {
    write_config(&config_file(&app, "settings.json")?, &data)
}

#[tauri::command]
fn load_themes(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_config(&config_file(&app, "themes.json")?)
}

#[tauri::command]
fn save_themes(app: tauri::AppHandle, data: String) -> Result<(), String> {
    write_config(&config_file(&app, "themes.json")?, &data)
}

/// The contents of a theme file the user picked in the dialog. The dialog is
/// what makes the path trusted; the command only reads it.
#[tauri::command]
fn load_theme_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|err| format!("read {path}: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kubi-config-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_reads_as_none() {
        let dir = temp_dir("missing");
        assert!(read_config(&dir.join("context-groups.json"))
            .unwrap()
            .is_none());
        assert!(read_config(&dir.join("settings.json")).unwrap().is_none());
        assert!(read_config(&dir.join("themes.json")).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_then_reads_and_leaves_no_temp_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("settings.json");
        let data = r#"{"version":1,"keybindings":{"openSearch":{"key":"a"}}}"#;
        write_config(&path, data).unwrap();
        assert_eq!(read_config(&path).unwrap().as_deref(), Some(data));
        // A second file in the same directory is untouched.
        let other = dir.join("context-groups.json");
        write_config(&other, "{}").unwrap();
        assert_eq!(read_config(&path).unwrap().as_deref(), Some(data));
        assert!(!path.with_extension("json.tmp").exists());
        write_config(&path, "{}").unwrap();
        assert_eq!(read_config(&path).unwrap().as_deref(), Some("{}"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
