// Opt-in live-account validation. Never runs on pull requests or auto-approves tools.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"nook/internal/model"
	"nook/internal/provider"
	"os"
	"runtime"
	"strings"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--permission-host" {
		provider.PermissionHost(os.Stdin, os.Stdout)
		return
	}
	live := flag.Bool("live", false, "Use a signed-in local agent (consumes provider usage)")
	id := flag.String("provider", "codex", "codex or claude")
	path := flag.String("executable", "", "Optional explicit installed executable path")
	report := flag.String("report", "", "Write a validation report")
	flag.Parse()
	if !*live {
		fmt.Fprintln(os.Stderr, "Pass --live to use your signed-in account. This check never approves tools.")
		os.Exit(2)
	}
	var info model.ProviderInfo
	for _, p := range provider.Discover(map[string]string{*id: *path}) {
		if p.ID == *id {
			info = p
		}
	}
	if !info.Available {
		fmt.Fprintln(os.Stderr, info.Problem)
		os.Exit(1)
	}
	dir, e := os.MkdirTemp("", "nook-live-")
	if e != nil {
		panic(e)
	}
	defer os.RemoveAll(dir)
	exe, _ := os.Executable()
	events := make(chan model.SessionEvent, 512)
	sessionID := ""
	passed := false
	detail := ""
	started := time.Now()
	for turn := 0; turn < 2; turn++ {
		rt, e := provider.Start(provider.Config{Info: info, Session: model.Session{Cwd: dir, ProviderID: sessionID}, Helper: exe, Emit: func(e model.SessionEvent) { events <- e }})
		if e != nil {
			detail = e.Error()
			break
		}
		e = rt.Send("Reply with exactly NOOK_OK. Do not use tools, read files, or run commands.")
		if e != nil {
			detail = e.Error()
			rt.Stop()
			break
		}
		done := false
		var answer strings.Builder
		timer := time.NewTimer(120 * time.Second)
	loop:
		for {
			select {
			case e := <-events:
				switch e.Kind {
				case "provider_id":
					sessionID = e.Text
				case "delta":
					answer.WriteString(e.Text)
				case "completed":
					done = strings.Contains(answer.String(), "NOOK_OK") && sessionID != ""
					if !done {
						detail = "Turn completed without the expected response or a resume identifier"
					}
					break loop
				case "error", "disconnected":
					detail = e.Text
					break loop
				case "approval":
					rt.Respond(model.ApprovalResponse{RequestID: e.Approval.ID, Decision: "decline"})
					detail = "Unexpected tool permission request was declined"
					break loop
				}
			case <-timer.C:
				detail = "Timed out waiting for completion"
				break loop
			}
		}
		timer.Stop()
		rt.Stop()
		if !done {
			break
		}
		if turn == 1 {
			passed = true
		}
		for len(events) > 0 {
			<-events
		}
	}
	output := map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "provider": info.ID, "version": info.Version, "launchAndResume": passed, "realApprovalsValidated": false, "durationSeconds": time.Since(started).Seconds(), "detail": detail, "timestamp": time.Now().UTC().Format(time.RFC3339)}
	b, _ := json.MarshalIndent(output, "", "  ")
	fmt.Println(string(b))
	if *report != "" {
		os.WriteFile(*report, b, 0600)
	}
	if !passed {
		os.Exit(1)
	}
}
