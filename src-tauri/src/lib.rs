mod compare;
mod endpoint;
mod filter;

use compare::{FilePair, Method, Outcome, Status};

#[tauri::command]
async fn compare(left: String, right: String, filters: String, method: Method) -> Result<Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || compare::run(&left, &right, &filters, method))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn verify(left: String, right: String, paths: Vec<String>) -> Result<Vec<Status>, String> {
    tauri::async_runtime::spawn_blocking(move || compare::verify(&left, &right, &paths))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_pair(
    left: String,
    right: String,
    rel: String,
    left_exists: bool,
    right_exists: bool,
) -> Result<FilePair, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compare::read_pair(&left, &right, &rel, left_exists, right_exists)
    })
    .await
    .map_err(|e| e.to_string())
}

/// List the children of a directory given as typed in an endpoint box (local or `host:path`).
#[tauri::command]
async fn list_children(base: String) -> Result<Vec<endpoint::Child>, String> {
    tauri::async_runtime::spawn_blocking(move || endpoint::parse(&base)?.children())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_file(root: String, rel: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || compare::write(&root, &rel, content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_hosts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(endpoint::ssh_hosts).await.unwrap_or_default()
}

/// What the user's OS wants a title-bar double-click to do: "Fill"/"Maximize", "Minimize" or "None".
#[tauri::command]
fn titlebar_double_click_action() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleActionOnDoubleClick"])
        .output()
    {
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !v.is_empty() {
            return v;
        }
    }
    "Maximize".into()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![compare, verify, read_pair, list_children, ssh_hosts, write_file, titlebar_double_click_action])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
