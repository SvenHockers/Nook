//! Worktree operations adapted from agent-deck's argument-array worktree approach
//! (MIT, revision 8d0f1fe1); no hooks/setup scripts or destructive removal.
use crate::model::Changes;
use crate::{err, private_dir, process, truncate, Res};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

fn run(dir: &str, args: &[&str]) -> Res<Vec<u8>> {
    let out = process::output(
        Command::new("git").arg("-C").arg(dir).args(args),
        Duration::from_secs(45),
    )
    .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git: {}: {}",
            String::from_utf8_lossy(&out.stderr).trim(),
            out.status
        ));
    }
    Ok(out.stdout)
}
fn text(dir: &str, args: &[&str]) -> Res<String> {
    run(dir, args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn is_repo(dir: &str) -> bool {
    text(dir, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|v| v.trim() == "true")
}
/// Returns the new worktree's path, branch and base commit.
pub fn create(dir: &str, root: &Path, id: &str) -> Res<(String, String, String)> {
    let base = text(dir, &["rev-parse", "--verify", "HEAD"])?
        .trim()
        .to_string();
    let path = root.join(id).to_string_lossy().into_owned();
    let branch = format!("nook/{}", id.get(..12).unwrap_or(id));
    private_dir(root).map_err(err)?;
    run(dir, &["worktree", "add", "-b", &branch, "--", &path, &base])?;
    Ok((path, branch, base))
}
pub fn changes(dir: &str, base: &str) -> Res<Changes> {
    let status = text(dir, &["status", "--short"])?;
    let base = if base.is_empty() { "HEAD" } else { base };
    let mut diff = text(dir, &["diff", "--no-ext-diff", "--no-textconv", base, "--"])?;
    let truncated = diff.len() > 1024 * 1024;
    if truncated {
        truncate(&mut diff, 1024 * 1024);
        diff += "\n[Preview truncated. Export the patch for the complete diff.]";
    }
    Ok(Changes {
        status,
        diff,
        truncated,
    })
}
/// Recorded code identity and summary; never evaluates project diff drivers.
pub fn head(dir: &str) -> Res<String> {
    text(dir, &["rev-parse", "--verify", "HEAD"]).map(|s| s.trim().into())
}
pub fn diff_stat(dir: &str, base: &str) -> Res<String> {
    let base = if base.is_empty() { "HEAD" } else { base };
    let mut stat = text(
        dir,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--stat",
            base,
            "--",
        ],
    )?;
    if stat.len() > 16 * 1024 {
        truncate(&mut stat, 16 * 1024);
        stat += "\n[Diff stat truncated]";
    }
    Ok(stat)
}

/// Raw bytes: an exported patch must keep non-UTF-8 content intact.
pub fn patch(dir: &str, base: &str) -> Res<Vec<u8>> {
    let base = if base.is_empty() { "HEAD" } else { base };
    run(
        dir,
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            base,
            "--",
        ],
    )
}

/// NUL-delimited paths, with renames disabled so each row has one unambiguous path.
pub fn evidence_inputs(dir: &str, base: &str) -> Res<(String, String)> {
    let base = if base.is_empty() { "HEAD" } else { base };
    Ok((
        text(
            dir,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--numstat",
                "-z",
                base,
                "--",
            ],
        )?,
        text(dir, &["status", "--porcelain=v1", "-z", "--no-renames"])?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TempDir;
    use std::fs;

    #[test]
    fn worktree_keeps_dirty_source_and_includes_commits() {
        let tmp = TempDir::new();
        if run(&tmp.0.to_string_lossy(), &["--version"]).is_err() {
            eprintln!("Git unavailable");
            return;
        }
        let dir = tmp.0.join("project ü spaces");
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy();
        // autocrlf off: Git for Windows would otherwise check out CRLF and fail the byte comparisons.
        for args in [
            &["init"][..],
            &["config", "user.email", "test@example.invalid"],
            &["config", "user.name", "Test"],
            &["config", "core.autocrlf", "false"],
        ] {
            run(&d, args).unwrap();
        }
        fs::write(dir.join("note.txt"), "base\n").unwrap();
        run(&d, &["add", "."]).unwrap();
        run(&d, &["commit", "-m", "initial"]).unwrap();
        fs::write(dir.join("note.txt"), "dirty source\n").unwrap();
        let (p, branch, base) = create(
            &d,
            &tmp.0.join("worktrees"),
            "12345678901234567890123456789012",
        )
        .unwrap();
        assert!(branch.starts_with("nook/"), "{branch}");
        assert_eq!(
            fs::read_to_string(Path::new(&p).join("note.txt")).unwrap(),
            "base\n",
            "copied uncommitted changes"
        );
        fs::write(Path::new(&p).join("note.txt"), "agent change\n").unwrap();
        run(&p, &["add", "."]).unwrap();
        run(
            &p,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "agent change",
            ],
        )
        .unwrap();
        let changes = changes(&p, &base).unwrap();
        assert!(changes.diff.contains("agent change"), "{changes:?}");
        assert_eq!(
            fs::read_to_string(dir.join("note.txt")).unwrap(),
            "dirty source\n",
            "source modified"
        );
    }
}
