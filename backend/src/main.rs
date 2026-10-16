// Nook's runtime is a private stdio sidecar owned by the Tauri shell.
use std::path::PathBuf;
use std::process::exit;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--permission-host") {
        let served =
            nook::provider::permission_host(std::io::stdin().lock(), std::io::stdout().lock());
        exit(i32::from(served.is_err()));
    }
    let (mut rpc, mut root) = (false, None);
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let flag = arg.trim_start_matches('-');
        match flag.split_once('=') {
            Some(("data-dir", v)) => root = Some(PathBuf::from(v)),
            None if flag == "rpc" => rpc = true,
            None if flag == "data-dir" => root = it.next().map(PathBuf::from),
            _ => {
                eprintln!("flag provided but not defined: {arg}\nUsage: nook-backend --rpc [--data-dir DIR]");
                exit(2);
            }
        }
    }
    if !rpc {
        eprintln!("This is Nook's backend. Open the Nook desktop application.");
        exit(2);
    }
    let root = root
        .filter(|r| !r.as_os_str().is_empty())
        .or_else(|| config_dir().map(|d| d.join("Nook")));
    let Some(root) = root else {
        eprintln!("Could not find the user configuration directory");
        exit(1);
    };
    let served = std::env::current_exe()
        .map_err(|e| e.to_string())
        .and_then(|exe| {
            nook::ipc::serve(
                std::io::stdin().lock(),
                std::io::stdout(),
                &root,
                &exe.to_string_lossy(),
            )
        });
    if let Err(e) = served {
        eprintln!("{e}");
        exit(1);
    }
}

/// %APPDATA%, ~/Library/Application Support, or the XDG config directory.
fn config_dir() -> Option<PathBuf> {
    let env = |k: &str| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if cfg!(windows) {
        env("APPDATA")
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|h| h.join("Library/Application Support"))
    } else {
        env("XDG_CONFIG_HOME").or_else(|| env("HOME").map(|h| h.join(".config")))
    }
}
