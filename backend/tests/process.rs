// Process ownership: stop reaches descendants, and recovery never touches a reused PID.
use nook::process;
use std::io::{BufRead, BufReader};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const FIXTURE: &str = env!("CARGO_BIN_EXE_nook-fixture");

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is checked and closed.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == 259 // STILL_ACTIVE
    }
}
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn stop_owns_descendants() {
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let (child, stdout) = process::start(FIXTURE, &["tree".into()], &cwd, &[]).unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let pid: u32 = line.trim().parse().expect("no child PID");
    let (tx, rx) = mpsc::channel();
    let waiter = child.clone();
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
        let _ = waiter.wait();
        let _ = tx.send(());
    });
    child.stop();
    rx.recv_timeout(Duration::from_secs(5))
        .expect("process did not stop");
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(pid), "descendant survived: {pid}");
}

#[test]
fn recovery_ignores_reused_process_id() {
    let pid = std::process::id();
    let birth = process::identity(pid).unwrap();
    if birth.is_empty() {
        return; // The platform does not expose process birth identity.
    }
    process::recover(i64::from(pid), "different-birth-time").unwrap();
    assert!(alive(pid), "recovery touched an unrelated process");
}
