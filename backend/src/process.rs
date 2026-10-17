//! Owned agent processes. Stop always reaches descendants: an owned process group on Unix,
//! a kill-on-close Job Object on Windows.
use crate::{err, lock, Gate, Res};
use std::io::{self, Read, Write};
use std::process::{Child as Proc, ChildStdin, ChildStdout, Command, ExitStatus, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub struct Child {
    pub pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    proc: Mutex<Proc>,
    done: Gate,
    group: Group,
}

/// Starts `exe` with piped stdin/stdout. Provider stderr may hold credentials and is discarded.
pub fn start(
    exe: &str,
    args: &[String],
    cwd: &str,
    env: &[(&str, &str)],
) -> Res<(Arc<Child>, ChildStdout)> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let (mut proc, group) = Group::spawn(&mut cmd).map_err(err)?;
    let stdout = proc.stdout.take().ok_or("stdout is unavailable")?;
    let child = Child {
        pid: proc.id(),
        stdin: Mutex::new(proc.stdin.take()),
        proc: Mutex::new(proc),
        done: Gate::new(1),
        group,
    };
    Ok((Arc::new(child), stdout))
}

/// Explicit user-run verification captures both streams; provider stderr remains discarded.
pub fn start_check(
    argv: &[String],
    cwd: &str,
) -> Res<(Arc<Child>, ChildStdout, std::process::ChildStderr)> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut proc, group) = Group::spawn(&mut cmd).map_err(err)?;
    let stdout = proc.stdout.take().ok_or("stdout is unavailable")?;
    let stderr = proc.stderr.take().ok_or("stderr is unavailable")?;
    let child = Arc::new(Child {
        pid: proc.id(),
        stdin: Mutex::new(None),
        proc: Mutex::new(proc),
        done: Gate::new(1),
        group,
    });
    Ok((child, stdout, stderr))
}

impl Child {
    /// Call once, after stdout has been drained.
    pub fn wait(&self) -> io::Result<ExitStatus> {
        let status = lock(&self.proc).wait();
        let _ = self.group.kill();
        self.done.done();
        status
    }
    pub fn write(&self, b: &[u8]) -> Res<()> {
        let mut stdin = lock(&self.stdin);
        let w = stdin.as_mut().ok_or("write |1: file already closed")?;
        w.write_all(b).and_then(|()| w.flush()).map_err(err)
    }
    pub fn close_stdin(&self) {
        lock(&self.stdin).take();
    }
    pub fn stop(&self) {
        if self.done.is_open() {
            return;
        }
        // A writer blocked on a full pipe holds the lock; the kill below unblocks it.
        if let Ok(mut stdin) = self.stdin.try_lock() {
            stdin.take();
        }
        let _ = self.group.interrupt();
        if !self.done.wait_timeout(Duration::from_millis(1500)) {
            let _ = self.group.kill();
            self.done.wait_timeout(Duration::from_secs(2));
        }
    }
}

/// Runs a short command, killing it after `limit`.
pub fn output(cmd: &mut Command, limit: Duration) -> io::Result<Output> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    fn drain(r: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
        thread::spawn(move || {
            let mut b = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut b);
            }
            b
        })
    }
    let (out, errs) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "signal: killed"));
        }
        thread::sleep(Duration::from_millis(10));
    };
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: errs.join().unwrap_or_default(),
    })
}

#[cfg(unix)]
struct Group {
    pid: i32,
    killed: std::sync::atomic::AtomicBool,
}
#[cfg(unix)]
impl Group {
    fn spawn(cmd: &mut Command) -> io::Result<(Proc, Group)> {
        use std::os::unix::process::CommandExt;
        let proc = cmd.process_group(0).spawn()?;
        let group = Group {
            pid: proc.id() as i32,
            killed: Default::default(),
        };
        Ok((proc, group))
    }
    fn interrupt(&self) -> io::Result<()> {
        signal(-self.pid, libc::SIGINT)
    }
    fn kill(&self) -> io::Result<()> {
        if self.killed.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        signal(-self.pid, libc::SIGKILL)
    }
}
#[cfg(unix)]
fn signal(pid: i32, sig: i32) -> io::Result<()> {
    // SAFETY: kill(2) has no memory-safety preconditions.
    match unsafe { libc::kill(pid, sig) } {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(windows)]
struct Group {
    // The Job handle, stored as an integer so Group is Send + Sync.
    job: Mutex<Option<usize>>,
}
#[cfg(windows)]
impl Group {
    fn spawn(cmd: &mut Command) -> io::Result<(Proc, Group)> {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};
        use windows_sys::Win32::System::JobObjects::*;
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED};
        // SAFETY: plain Win32 calls on handles owned by this function.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let group = Group {
                job: Mutex::new(Some(job as usize)),
            };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of_val(&info) as u32;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size,
            ) == 0
            {
                let e = io::Error::last_os_error();
                let _ = group.kill();
                return Err(e);
            }
            // Start suspended so descendants cannot escape before job assignment.
            let mut proc = match cmd
                .creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP)
                .spawn()
            {
                Ok(p) => p,
                Err(e) => {
                    let _ = group.kill();
                    return Err(e);
                }
            };
            if AssignProcessToJobObject(job, proc.as_raw_handle()) == 0 {
                let e = io::Error::last_os_error();
                let _ = proc.kill();
                let _ = proc.wait();
                let _ = group.kill();
                return Err(e);
            }
            let status = resume(proc.as_raw_handle());
            if status != 0 {
                let _ = group.kill();
                let _ = proc.wait();
                return Err(io::Error::other(format!(
                    "NtResumeProcess failed: {status:#x}"
                )));
            }
            Ok((proc, group))
        }
    }
    fn interrupt(&self) -> io::Result<()> {
        self.kill()
    }
    fn kill(&self) -> io::Result<()> {
        match lock(&self.job).take() {
            // SAFETY: the handle came from CreateJobObjectW and is closed exactly once.
            Some(h) if unsafe { windows_sys::Win32::Foundation::CloseHandle(h as _) } == 0 => {
                Err(io::Error::last_os_error())
            }
            _ => Ok(()),
        }
    }
}
/// NtResumeProcess is undocumented, so it is resolved at runtime rather than linked.
#[cfg(windows)]
unsafe fn resume(process: std::os::windows::io::RawHandle) -> i32 {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    let name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    match GetProcAddress(
        GetModuleHandleW(name.as_ptr()),
        c"NtResumeProcess".as_ptr().cast(),
    ) {
        Some(f) => std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            unsafe extern "system" fn(_) -> i32,
        >(f)(process),
        None => -1,
    }
}

#[cfg(windows)]
fn windows_identity(pid: u32) -> io::Result<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is checked and closed; FILETIME outputs are plain data.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut t = [FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        }; 4];
        let [created, exited, kernel, user] = &mut t;
        let ok = GetProcessTimes(h, created, exited, kernel, user);
        let e = io::Error::last_os_error();
        CloseHandle(h);
        if ok == 0 {
            return Err(e);
        }
        Ok(format!("{}:{}", t[0].dwHighDateTime, t[0].dwLowDateTime))
    }
}
#[cfg(windows)]
pub fn identity(pid: u32) -> Res<String> {
    windows_identity(pid).map_err(err)
}
/// Terminates a recorded process only when its kernel birth time still matches.
#[cfg(windows)]
pub fn recover(pid: i64, birth: &str) -> Res<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    if pid <= 0 || birth.is_empty() {
        return Ok(());
    }
    match windows_identity(pid as u32) {
        Err(e) if e.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => return Ok(()),
        Err(e) => return Err(err(e)),
        Ok(id) if id != birth => return Ok(()),
        Ok(_) => {}
    }
    // SAFETY: the handle is checked and closed.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
        if h.is_null() {
            return Err(err(io::Error::last_os_error()));
        }
        let ok = TerminateProcess(h, 1);
        let e = io::Error::last_os_error();
        CloseHandle(h);
        if ok == 0 {
            return Err(err(e));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn bsd_info(pid: i32) -> io::Result<libc::proc_bsdinfo> {
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: proc_pidinfo writes at most `size` bytes into the zeroed struct.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        if libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut _,
            size,
        ) != size
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info)
    }
}
#[cfg(target_os = "macos")]
fn birth_of(info: &libc::proc_bsdinfo) -> String {
    format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec)
}
#[cfg(target_os = "macos")]
pub fn identity(pid: u32) -> Res<String> {
    bsd_info(pid as i32).map(|i| birth_of(&i)).map_err(err)
}
/// Recover only terminates a recorded group leader with the same kernel birth time.
/// A reused PID or a missing process is never treated as Nook-owned.
#[cfg(target_os = "macos")]
pub fn recover(pid: i64, birth: &str) -> Res<()> {
    if pid <= 0 || birth.is_empty() {
        return Ok(());
    }
    let info = match bsd_info(pid as i32) {
        Err(e) if matches!(e.raw_os_error(), Some(libc::ESRCH | libc::ENOENT)) => return Ok(()),
        r => r.map_err(err)?,
    };
    if birth_of(&info) != birth {
        return Ok(());
    }
    if i64::from(info.pbi_pgid) != pid {
        return Err("Recorded process no longer leads its owned group".into());
    }
    match signal(-(pid as i32), libc::SIGKILL) {
        Err(e) if e.raw_os_error() != Some(libc::ESRCH) => Err(err(e)),
        _ => Ok(()),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn identity(_pid: u32) -> Res<String> {
    Ok(String::new())
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn recover(pid: i64, birth: &str) -> Res<()> {
    if pid > 0 && !birth.is_empty() {
        return Err("Process recovery is unsupported on this platform".into());
    }
    Ok(())
}
