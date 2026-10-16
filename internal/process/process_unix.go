//go:build !windows

package process

import (
	"sync"
	"syscall"
)

func platformStart(c *Child) error {
	c.Cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := c.Cmd.Start(); err != nil {
		return err
	}
	var once sync.Once
	c.kill = func() error {
		var err error
		once.Do(func() { err = syscall.Kill(-c.Cmd.Process.Pid, syscall.SIGKILL) })
		return err
	}
	return nil
}
func interrupt(c *Child) error { return syscall.Kill(-c.Cmd.Process.Pid, syscall.SIGINT) }
