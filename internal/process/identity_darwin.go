//go:build darwin

package process

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"syscall"
)

func Identity(pid int) (string, error) {
	k, e := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if e != nil {
		return "", e
	}
	return fmt.Sprintf("%d:%d", k.Proc.P_starttime.Sec, k.Proc.P_starttime.Usec), nil
}

// Recover only terminates a recorded group leader with the same kernel birth time.
// A reused PID or a missing process is never treated as Nook-owned.
func Recover(pid int, birth string) error {
	if pid <= 0 || birth == "" {
		return nil
	}
	k, e := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if errors.Is(e, syscall.ESRCH) || errors.Is(e, syscall.ENOENT) {
		return nil
	}
	if e != nil {
		return e
	}
	if fmt.Sprintf("%d:%d", k.Proc.P_starttime.Sec, k.Proc.P_starttime.Usec) != birth {
		return nil
	}
	if int(k.Eproc.Pgid) != pid {
		return errors.New("Recorded process no longer leads its owned group")
	}
	e = syscall.Kill(-pid, syscall.SIGKILL)
	if errors.Is(e, syscall.ESRCH) {
		return nil
	}
	return e
}
