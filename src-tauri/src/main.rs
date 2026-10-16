#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
struct Backend {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next: AtomicU64,
    closing: AtomicBool,
}
impl Backend {
    async fn call(&self, method: &str, args: Vec<Value>) -> Reply {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Backend lock failed")?
            .insert(id, tx);
        let wire = format!("{}\n", json!({"id":id,"method":method,"args":args}));
        let write = match self.child.lock() {
            Ok(mut child) => match child.as_mut() {
                Some(child) => child.write(wire.as_bytes()).map_err(|e| e.to_string()),
                None => Err("Nook runtime is disconnected".into()),
            },
            Err(_) => Err("Backend lock failed".into()),
        };
        if let Err(e) = write {
            self.pending.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
        let result = match tokio::time::timeout(Duration::from_secs(90), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Nook runtime disconnected".into()),
            Err(_) => Err(format!(
                "{method} timed out. Check session state before retrying."
            )),
        };
        self.pending.lock().unwrap().remove(&id);
        result
    }
    fn disconnected(&self) {
        self.child.lock().unwrap().take();
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(
                "Nook runtime disconnected. Reopen Nook to restore your sessions.".into(),
            ));
        }
    }
}
const METHODS: &[&str] = &[
    "Snapshot",
    "AddProject",
    "Launch",
    "CreateWorkflow",
    "StartWorkflowTask",
    "AcceptWorkflowTask",
    "WorkflowEvidence",
    "Send",
    "Stop",
    "Respond",
    "Events",
    "RefreshProviders",
    "SetExecutable",
    "Context",
    "Archive",
    "Rename",
    "Changes",
    "ExportPatch",
    "Reveal",
    "Navigation",
    "SaveNavigation",
];
#[tauri::command]
async fn backend_call(
    backend: tauri::State<'_, Arc<Backend>>,
    method: String,
    args: Vec<Value>,
) -> Reply {
    if !METHODS.contains(&method.as_str()) {
        return Err("Unsupported application command".into());
    }
    if backend.closing.load(Ordering::SeqCst) {
        return Err("Nook is quitting".into());
    }
    backend.call(&method, args).await
}
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![backend_call])
        .setup(|app| {
            let root = app.path().config_dir()?.join("Nook");
            let (mut events, child) = app
                .shell()
                .sidecar("nook-backend")?
                .args(["--rpc", "--data-dir", &root.to_string_lossy()])
                .spawn()?;
            let backend = Arc::new(Backend {
                child: Mutex::new(Some(child)),
                pending: Mutex::new(HashMap::new()),
                next: AtomicU64::new(1),
                closing: AtomicBool::new(false),
            });
            app.manage(backend.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                                if let Some(name) = value["event"].as_str() {
                                    if name.starts_with("nook:") {
                                        let _ = handle.emit(name, &value["result"]);
                                    }
                                } else if let Some(id) = value["id"].as_u64() {
                                    if let Some(tx) = backend.pending.lock().unwrap().remove(&id) {
                                        let result = if let Some(error) = value["error"].as_str() {
                                            Err(error.into())
                                        } else {
                                            Ok(value["result"].clone())
                                        };
                                        let _ = tx.send(result);
                                    }
                                }
                            }
                        }
                        CommandEvent::Terminated(_) | CommandEvent::Error(_) => {
                            backend.disconnected();
                            let _ = handle.emit("nook:changed", ());
                            break;
                        }
                        // Do not forward raw stderr: provider/authentication diagnostics may contain secrets.
                        _ => {}
                    }
                }
                backend.disconnected();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start Nook");
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let backend = handle.state::<Arc<Backend>>().inner().clone();
            if !backend.closing.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = backend.call("Shutdown", vec![]).await;
                    if let Some(child) = backend.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                    app.exit(0);
                });
            }
        }
    });
}
