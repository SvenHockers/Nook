package process

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestHelper(t *testing.T) {
	if os.Getenv("NOOK_PROCESS_HELPER") == "" {
		return
	}
	if os.Getenv("NOOK_PROCESS_LEAF") == "1" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestHelper")
	cmd.Env = append(os.Environ(), "NOOK_PROCESS_LEAF=1")
	if e := cmd.Start(); e != nil {
		os.Exit(2)
	}
	fmt.Println(cmd.Process.Pid)
	time.Sleep(30 * time.Second)
	os.Exit(0)
}
func TestStopOwnsDescendants(t *testing.T) {
	c, e := Start(os.Args[0], []string{"-test.run=TestHelper"}, t.TempDir(), []string{"NOOK_PROCESS_HELPER=1"})
	if e != nil {
		t.Fatal(e)
	}
	scan := bufio.NewScanner(c.Out)
	if !scan.Scan() {
		t.Fatal("no child PID")
	}
	pid, e := strconv.Atoi(scan.Text())
	if e != nil {
		t.Fatal(e)
	}
	go func() { io.Copy(io.Discard, c.Out); c.Wait() }()
	c.Stop()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("process did not stop")
	}
	deadline := time.Now().Add(3 * time.Second)
	for alive(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if alive(pid) {
		t.Fatal("descendant survived", pid)
	}
}

func TestRecoveryIgnoresReusedProcessID(t *testing.T) {
	birth, err := Identity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if birth == "" {
		t.Skip("Platform does not expose process birth identity")
	}
	if err := Recover(os.Getpid(), "different-birth-time"); err != nil {
		t.Fatal(err)
	}
	if !alive(os.Getpid()) {
		t.Fatal("recovery touched unrelated process")
	}
}
