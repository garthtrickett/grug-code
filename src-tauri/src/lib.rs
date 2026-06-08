#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_shell::ShellExt;
                let app_handle = app.handle().clone();
                
                // Spawn the compiled Bun grug-daemon sidecar process.
                // We pass "DAEMON_PORT" = "42069" so it binds directly to the port Vite expects.
                // Tauri handles cleaning up the spawned sidecar process upon exit.
                match app_handle.shell().sidecar("grug-daemon") {
                    Ok(sidecar) => {
                        let sidecar = sidecar.env("DAEMON_PORT", "42069");
                        match sidecar.spawn() {
                            Ok((_rx, _child)) => {
                                println!("[Tauri Core] Spawning grug-daemon sidecar on port 42069 successful.");
                            }
                            Err(e) => {
                                eprintln!("[Tauri Core] Error spawning grug-daemon sidecar: {:?}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[Tauri Core] Error locating grug-daemon sidecar: {:?}", e);
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
