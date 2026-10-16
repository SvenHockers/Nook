//go:build darwin

package desktop

import "os/exec"

func Reveal(path string) error { return exec.Command("/usr/bin/open", path).Run() }
