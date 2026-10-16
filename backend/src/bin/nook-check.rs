// Opt-in live-account validation. Never runs on pull requests or auto-approves tools.
use nook::model::{id, now, ApprovalResponse, Session, SessionEvent};
use nook::provider::{self, Config};
use serde_json::json;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::process::exit;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--permission-host") {
        let _ = provider::permission_host(std::io::stdin().lock(), std::io::stdout().lock());
        return;
    }
    let (mut live, mut provider_id, mut executable, mut report) =
        (false, "codex".to_string(), String::new(), String::new());
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let flag = arg.trim_start_matches('-');
        let (name, inline) = flag
            .split_once('=')
            .map_or((flag, None), |(n, v)| (n, Some(v.to_string())));
        let mut value = || inline.clone().or_else(|| it.next()).unwrap_or_default();
        match name {
            "live" => live = true,
            "provider" => provider_id = value(),
            "executable" => executable = value(),
            "report" => report = value(),
            _ => {
                eprintln!("flag provided but not defined: {arg}");
                exit(2);
            }
        }
    }
    if !live {
        eprintln!("Pass --live to use your signed-in account. This check never approves tools.");
        exit(2);
    }
    let info = provider::discover(&HashMap::from([(provider_id.clone(), executable)]))
        .into_iter()
        .find(|p| p.id == provider_id)
        .unwrap_or_default();
    if !info.available {
        eprintln!("{}", info.problem);
        exit(1);
    }
    let dir = std::env::temp_dir().join(format!("nook-live-{}", id()));
    std::fs::create_dir_all(&dir).expect("could not create a temporary folder");
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (tx, rx) = mpsc::channel::<SessionEvent>();
    let (mut session_id, mut passed, mut detail) = (String::new(), false, String::new());
    let started = Instant::now();
    for turn in 0..2 {
        let tx = tx.clone();
        let session = Session {
            cwd: dir.to_string_lossy().into_owned(),
            provider_id: session_id.clone(),
            ..Default::default()
        };
        let rt = match provider::start(Config {
            info: info.clone(),
            session,
            helper: exe.clone(),
            emit: Arc::new(move |e| drop(tx.send(e))),
        }) {
            Ok(rt) => rt,
            Err(e) => {
                detail = e;
                break;
            }
        };
        if let Err(e) =
            rt.send("Reply with exactly NOOK_OK. Do not use tools, read files, or run commands.")
        {
            detail = e;
            rt.stop();
            break;
        }
        let (mut done, mut answer) = (false, String::new());
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let Ok(e) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) else {
                detail = "Timed out waiting for completion".into();
                break;
            };
            match e.kind.as_str() {
                "provider_id" => session_id = e.text,
                "delta" => answer += &e.text,
                "completed" => {
                    done = answer.contains("NOOK_OK") && !session_id.is_empty();
                    if !done {
                        detail =
                            "Turn completed without the expected response or a resume identifier"
                                .into();
                    }
                    break;
                }
                "error" | "disconnected" => {
                    detail = e.text;
                    break;
                }
                "approval" => {
                    if let Some(a) = e.approval {
                        let _ = rt.respond(&ApprovalResponse {
                            request_id: a.id,
                            decision: "decline".into(),
                            ..Default::default()
                        });
                    }
                    detail = "Unexpected tool permission request was declined".into();
                    break;
                }
                _ => {}
            }
        }
        rt.stop();
        if !done {
            break;
        }
        passed = turn == 1;
        while rx.try_recv().is_ok() {}
    }
    // Report the platform in the same terms as earlier validation reports.
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        arch => arch,
    };
    let output = json!({"os": os, "arch": arch, "provider": info.id, "version": info.version, "launchAndResume": passed, "realApprovalsValidated": false, "durationSeconds": started.elapsed().as_secs_f64(), "detail": detail, "timestamp": now()});
    let text = serde_json::to_string_pretty(&output).unwrap_or_default();
    println!("{text}");
    if !report.is_empty() {
        let written = nook::private_file(
            report.as_ref(),
            OpenOptions::new().write(true).create(true).truncate(true),
        )
        .and_then(|mut f| f.write_all(text.as_bytes()));
        if let Err(e) = written {
            eprintln!("Could not write the report: {e}");
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    if !passed {
        exit(1);
    }
}
