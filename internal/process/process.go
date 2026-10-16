package process

import (
	"io"
	"nook/internal/logging"
	"os"
	"os/exec"
	"sync"
	"time"
)

type Child struct {
	Cmd     *exec.Cmd
	In      io.WriteCloser
	Out     io.ReadCloser
	Err     *logging.RingBuffer
	done    chan struct{}
	waitErr error
	kill    func() error
	mu      sync.Mutex
}

func Start(exe string, args []string, cwd string, env []string) (*Child, error) {
	cmd := exec.Command(exe, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), env...)
	c := &Child{Cmd: cmd, Err: logging.NewRingBuffer(64 * 1024), done: make(chan struct{})}
	cmd.Stderr = c.Err
	var err error
	c.In, err = cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	c.Out, err = cmd.StdoutPipe()
	if err != nil {
		c.In.Close()
		return nil, err
	}
	if err = platformStart(c); err != nil {
		c.In.Close()
		c.Out.Close()
		return nil, err
	}
	return c, nil
}

// Wait must be called after stdout has been drained, once per process.
func (c *Child) Wait() error {
	c.waitErr = c.Cmd.Wait()
	if c.kill != nil {
		_ = c.kill()
	}
	close(c.done)
	return c.waitErr
}
func (c *Child) Write(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.In.Write(b)
	return err
}
func (c *Child) Stop() {
	select {
	case <-c.done:
		return
	default:
	}
	_ = c.In.Close()
	_ = interrupt(c)
	select {
	case <-c.done:
	case <-time.After(1500 * time.Millisecond):
		if c.kill != nil {
			_ = c.kill()
		}
		select {
		case <-c.done:
		case <-time.After(2 * time.Second):
		}
	}
}
