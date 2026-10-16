//! Reveals retained work in the platform file manager.
use crate::Res;

#[cfg(target_os = "macos")]
pub fn reveal(path: &str) -> Res<()> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .map_err(crate::err)?;
    if status.success() {
        Ok(())
    } else {
        Err(status.to_string())
    }
}
#[cfg(windows)]
pub fn reveal(path: &str) -> Res<()> {
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map(drop)
        .map_err(crate::err)
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn reveal(_path: &str) -> Res<()> {
    Err("Unsupported platform".into())
}
