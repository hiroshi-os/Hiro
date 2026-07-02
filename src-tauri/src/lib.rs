mod commands;

use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::capture_screen,
            commands::execute_action,
            commands::start_agent_loop,
            commands::update_routing_settings,
            commands::trigger_panic
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            // Bind Shift + Escape to panic handler
            let shortcut = Shortcut::new(
                Some(tauri_plugin_global_shortcut::Modifiers::SHIFT),
                tauri_plugin_global_shortcut::Code::Escape
            );
            
            app.global_shortcut().on_shortcut(shortcut, move |_, _, _| {
                let handle = app_handle.clone();
                tokio::spawn(async move {
                    let _ = commands::trigger_panic(handle).await;
                });
            }).map_err(|e| format!("Failed to register global hotkey: {}", e))?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
