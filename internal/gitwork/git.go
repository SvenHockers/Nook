package gitwork

import (
	"context"
	"fmt"
	"nook/internal/model"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func run(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	a := append([]string{"-C", dir}, args...)
	b, e := exec.CommandContext(ctx, "git", a...).CombinedOutput()
	if e != nil {
		return "", fmt.Errorf("git: %s: %w", strings.TrimSpace(string(b)), e)
	}
	return string(b), nil
}

// IsGitRepo and Create adapt agent-deck's argument-array worktree operations
// (MIT, revision 8d0f1fe1); no hooks/setup scripts or destructive removal.
func IsGitRepo(dir string) bool {
	v, e := run(dir, "rev-parse", "--is-inside-work-tree")
	return e == nil && strings.TrimSpace(v) == "true"
}
func Create(dir, root, id string) (path, branch, base string, err error) {
	base, err = run(dir, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return
	}
	base = strings.TrimSpace(base)
	path = filepath.Join(root, id)
	branch = "nook/" + id[:12]
	if err = os.MkdirAll(root, 0700); err != nil {
		return
	}
	_, err = run(dir, "worktree", "add", "-b", branch, "--", path, base)
	return
}
func Changes(dir, base string) (model.Changes, error) {
	s, e := run(dir, "status", "--short")
	if e != nil {
		return model.Changes{}, e
	}
	if base == "" {
		base = "HEAD"
	}
	d, e := run(dir, "diff", "--no-ext-diff", "--no-textconv", base, "--")
	if e != nil {
		return model.Changes{}, e
	}
	truncated := len(d) > 1024*1024
	if truncated {
		d = d[:1024*1024] + "\n[Preview truncated. Export the patch for the complete diff.]"
	}
	return model.Changes{Status: s, Diff: d, Truncated: truncated}, nil
}
func Patch(dir, base string) (string, error) {
	if base == "" {
		base = "HEAD"
	}
	return run(dir, "diff", "--binary", "--no-ext-diff", "--no-textconv", base, "--")
}
