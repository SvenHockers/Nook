//go:build windows

package process

import (
	"golang.org/x/sys/windows"
	"sync"
	"syscall"
	"unsafe"
)

func platformStart(c *Child) error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return err
	}
	// Start suspended to prevent descendants escaping before job assignment.
	c.Cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NEW_PROCESS_GROUP}
	if err = c.Cmd.Start(); err != nil {
		windows.CloseHandle(job)
		return err
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_SUSPEND_RESUME, false, uint32(c.Cmd.Process.Pid))
	if err != nil {
		c.Cmd.Process.Kill()
		c.Cmd.Wait()
		windows.CloseHandle(job)
		return err
	}
	defer windows.CloseHandle(h)
	if err = windows.AssignProcessToJobObject(job, h); err != nil {
		c.Cmd.Process.Kill()
		c.Cmd.Wait()
		windows.CloseHandle(job)
		return err
	}
	resume := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtResumeProcess")
	status, _, _ := resume.Call(uintptr(h))
	if status != 0 {
		windows.CloseHandle(job)
		c.Cmd.Wait()
		return syscall.Errno(status)
	}
	var once sync.Once
	c.kill = func() error { var e error; once.Do(func() { e = windows.CloseHandle(job) }); return e }
	return nil
}
func interrupt(c *Child) error { return c.kill() }
