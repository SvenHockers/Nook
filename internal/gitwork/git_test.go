package gitwork

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorktreeKeepsDirtySourceAndIncludesCommits(t *testing.T) {
	if _, e := run(t.TempDir(), "--version"); e != nil {
		t.Skip("Git unavailable")
	}
	dir := filepath.Join(t.TempDir(), "project ü spaces")
	os.MkdirAll(dir, 0700)
	for _, args := range [][]string{{"init"}, {"config", "user.email", "test@example.invalid"}, {"config", "user.name", "Test"}} {
		if _, e := run(dir, args...); e != nil {
			t.Fatal(e)
		}
	}
	os.WriteFile(filepath.Join(dir, "note.txt"), []byte("base\n"), 0600)
	run(dir, "add", ".")
	if _, e := run(dir, "commit", "-m", "initial"); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(dir, "note.txt"), []byte("dirty source\n"), 0600)
	p, branch, base, e := Create(dir, filepath.Join(t.TempDir(), "worktrees"), "12345678901234567890123456789012")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.HasPrefix(branch, "nook/") {
		t.Fatal(branch)
	}
	data, _ := os.ReadFile(filepath.Join(p, "note.txt"))
	if string(data) != "base\n" {
		t.Fatal("copied uncommitted changes")
	}
	os.WriteFile(filepath.Join(p, "note.txt"), []byte("agent change\n"), 0600)
	run(p, "add", ".")
	run(p, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "agent change")
	changes, e := Changes(p, base)
	if e != nil || !strings.Contains(changes.Diff, "agent change") {
		t.Fatal(changes, e)
	}
	data, _ = os.ReadFile(filepath.Join(dir, "note.txt"))
	if string(data) != "dirty source\n" {
		t.Fatal("source modified")
	}
}
