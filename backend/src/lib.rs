//! Nook's runtime: a private stdio sidecar owned by the Tauri shell.
pub mod desktop;
pub mod git;
pub mod ipc;
pub mod model;
pub mod presentation;
pub mod process;
pub mod provider;
pub mod store;
pub mod workspace;

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Read};
use std::path::Path;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Errors cross the wire as plain text, so they stay strings throughout.
pub type Res<T> = Result<T, String>;

pub fn err(e: impl ToString) -> String {
    e.to_string()
}

/// Locks without poisoning: one panicked worker must not wedge the runtime.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Counts outstanding work. `Gate::new(1)` doubles as a one-shot latch.
#[derive(Default)]
pub struct Gate {
    count: Mutex<usize>,
    zero: Condvar,
}
impl Gate {
    pub fn new(n: usize) -> Gate {
        Gate {
            count: Mutex::new(n),
            zero: Condvar::new(),
        }
    }
    pub fn add(&self) {
        *lock(&self.count) += 1;
    }
    pub fn done(&self) {
        let mut c = lock(&self.count);
        *c = c.saturating_sub(1);
        if *c == 0 {
            self.zero.notify_all();
        }
    }
    pub fn is_open(&self) -> bool {
        *lock(&self.count) == 0
    }
    pub fn wait(&self) {
        let mut c = lock(&self.count);
        while *c > 0 {
            c = self.zero.wait(c).unwrap_or_else(PoisonError::into_inner);
        }
    }
    pub fn wait_timeout(&self, d: Duration) -> bool {
        let c = lock(&self.count);
        let (c, _) = self
            .zero
            .wait_timeout_while(c, d, |c| *c > 0)
            .unwrap_or_else(PoisonError::into_inner);
        *c == 0
    }
}

/// Runs a closure when dropped, so cleanup also happens on early return or panic.
pub struct OnDrop<F: FnMut()>(pub F);
impl<F: FnMut()> Drop for OnDrop<F> {
    fn drop(&mut self) {
        (self.0)()
    }
}

/// Reads one line without its line ending. A line longer than `max` is an error, like bufio.Scanner.
pub fn read_line(r: &mut impl BufRead, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    r.take(max as u64 + 1).read_until(b'\n', &mut line)?;
    if line.last() == Some(&b'\n') {
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
    } else if line.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bufio.Scanner: token too long",
        ));
    } else if line.is_empty() {
        return Ok(None);
    }
    Ok(Some(line))
}

/// Shortens `s` to at most `max` bytes without splitting a character.
pub fn truncate(s: &mut String, max: usize) {
    if s.len() > max {
        let mut n = max;
        while !s.is_char_boundary(n) {
            n -= 1;
        }
        s.truncate(n);
    }
}

/// Creates owner-only directories (0700 on Unix).
pub fn private_dir(path: &Path) -> io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(path)
}

/// Opens a file created owner-only (0600 on Unix).
pub fn private_file(path: &Path, opts: &mut OpenOptions) -> io::Result<File> {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(opts, 0o600);
    opts.open(path)
}

/// A test directory removed when dropped.
#[cfg(test)]
pub(crate) struct TempDir(pub std::path::PathBuf);
#[cfg(test)]
impl TempDir {
    pub fn new() -> TempDir {
        let p = std::env::temp_dir().join(format!("nook-test-{}", model::id()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
#[cfg(test)]
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
