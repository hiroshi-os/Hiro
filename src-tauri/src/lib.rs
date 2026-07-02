mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::capture_screen,
            commands::execute_action,
            commands::start_agent_loop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

