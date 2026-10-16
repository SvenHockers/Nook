//go:build windows

package process

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
)

func Identity(pid int) (string, error) {
	h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if e != nil {
		return "", e
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	e = windows.GetProcessTimes(h, &created, &exited, &kernel, &user)
	return fmt.Sprintf("%d:%d", created.HighDateTime, created.LowDateTime), e
}
func Recover(pid int, birth string) error {
	if pid <= 0 || birth == "" {
		return nil
	}
	id, e := Identity(pid)
	if errors.Is(e, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if e != nil {
		return e
	}
	if id != birth {
		return nil
	}
	h, e := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if e != nil {
		return e
	}
	defer windows.CloseHandle(h)
	return windows.TerminateProcess(h, 1)
}
