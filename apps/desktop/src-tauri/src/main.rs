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
        .invoke_handler(tauri::generate_handler![send_command])
        .run(tauri::generate_context!())
        .expect("error while running Kubi");
}

#[tauri::command]
fn send_command(sender: tauri::State<'_, CoreSender>, command: Command) {
    sender.send(command);
}
