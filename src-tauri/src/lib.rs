// File: ./src-tauri/src/lib.rs
// ==============================================================================
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
                        // Pass environment flags to disable JIT compilation, preventing SIGTRAP compiler blockages on NixOS
                        let mut sidecar = sidecar.env("DAEMON_PORT", "42069")
                            .env("BUN_JIT", "0")
                            .env("JSC_useJIT", "false");
                        
                        // Pass the current parent workspace directory down explicitly
                        if let Ok(cwd) = std::env::current_dir() {
                            let mut root = cwd.clone();
                            if root.ends_with("src-tauri") {
                                root.pop();
                            }
                            if let Some(root_str) = root.to_str() {
                                sidecar = sidecar.env("WORKSPACE_ROOT", root_str);
                            }
                        }

                        // Explicitly inherit and forward all parent environment variables
                        for (key, value) in std::env::vars() {
                            sidecar = sidecar.env(key, value);
                        }

                        match sidecar.spawn() {
                            Ok((mut rx, _child)) => {
                                println!("[Tauri Core] Spawning grug-daemon sidecar on port 42069 successful.");
                                
                                // Spawn an async task to handle sidecar communication and forward log streams to the host console
                                tauri::async_runtime::spawn(async move {
                                    use tauri_plugin_shell::process::CommandEvent;
                                    while let Some(event) = rx.recv().await {
                                        match event {
                                            CommandEvent::Stdout(line_bytes) => {
                                                let line = String::from_utf8_lossy(&line_bytes);
                                                print!("{}", line);
                                            }
                                            CommandEvent::Stderr(line_bytes) => {
                                                let line = String::from_utf8_lossy(&line_bytes);
                                                eprint!("{}", line);
                                            }
                                            CommandEvent::Error(err) => {
                                                eprintln!("[Sidecar Error] {:?}", err);
                                            }
                                            _ => {}
                                        }
                                    }
                                });
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
