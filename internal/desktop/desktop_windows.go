//go:build windows

package desktop

import "os/exec"

func Reveal(path string) error { return exec.Command("explorer.exe", path).Start() }
