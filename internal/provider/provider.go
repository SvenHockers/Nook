package provider

import (
	"context"
	"fmt"
	"nook/internal/model"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Emit func(model.SessionEvent)
type Runtime interface {
	Send(string) error
	Interrupt() error
	Stop()
	Respond(model.ApprovalResponse) error
}
type Config struct {
	Info    model.ProviderInfo
	Session model.Session
	Emit    Emit
	Helper  string
}

func Start(c Config) (Runtime, error) {
	switch c.Info.ID {
	case "codex":
		return startCodex(c)
	case "claude":
		return startClaude(c)
	}
	return nil, fmt.Errorf("unknown provider")
}
func Discover(overrides map[string]string) []model.ProviderInfo {
	out := []model.ProviderInfo{}
	home, _ := os.UserHomeDir()
	for _, id := range []string{"claude", "codex"} {
		p := model.ProviderInfo{ID: id, Name: map[string]string{"claude": "Claude Code", "codex": "Codex"}[id], Capabilities: model.ProviderCapabilities{Resume: true, Interrupt: true, Approvals: true, Questions: true, Sandbox: "Provider-managed; inspect provider configuration"}}
		if runtime.GOOS == "windows" && id == "claude" {
			p.Capabilities.Sandbox = "Tool permissions only. No native Windows OS sandbox."
		}
		candidates := []string{}
		if override := overrides[id]; override != "" {
			candidates = append(candidates, override)
		} else {
			if path, e := exec.LookPath(id); e == nil {
				candidates = append(candidates, path)
			}
			name := id
			if runtime.GOOS == "windows" {
				name += ".exe"
			}
			candidates = append(candidates, filepath.Join(home, ".local", "bin", name), filepath.Join(home, ".cargo", "bin", name), filepath.Join("/opt/homebrew/bin", name), filepath.Join("/usr/local/bin", name))
			if runtime.GOOS == "windows" {
				candidates = append(candidates, filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WinGet", "Links", name))
			}
		}
		for _, path := range candidates {
			if st, e := os.Stat(path); e != nil || st.IsDir() {
				continue
			}
			if strings.EqualFold(filepath.Ext(path), ".cmd") || strings.EqualFold(filepath.Ext(path), ".bat") {
				p.Problem = "Select the native .exe installation; shell wrappers are not supported."
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			b, e := exec.CommandContext(ctx, path, "--version").CombinedOutput()
			cancel()
			if e != nil {
				p.Problem = "Cannot run this executable. Check installation and permissions."
				continue
			}
			p.Path = path
			p.Version = strings.TrimSpace(string(b))
			p.Available = true
			break
		}
		if !p.Available && p.Problem == "" {
			p.Problem = "Not installed or not found. Install and sign in, then refresh or select the executable."
		}
		if p.Available && id == "claude" && !atLeast(p.Version, 2, 1, 295) {
			p.Available = false
			p.Problem = "Claude Code 2.1.295 or newer is required for hooks that block on connection failure."
		}
		out = append(out, p)
	}
	return out
}
func atLeast(v string, a, b, c int) bool {
	m := regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`).FindStringSubmatch(v)
	if len(m) < 4 {
		return false
	}
	want := []int{a, b, c}
	for i := 0; i < 3; i++ {
		n, _ := strconv.Atoi(m[i+1])
		if n != want[i] {
			return n > want[i]
		}
	}
	return true
}
func event(kind, text string) model.SessionEvent { return model.SessionEvent{Kind: kind, Text: text} }
func ExplainError(s string) string {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "401"), strings.Contains(l, "authenticat"), strings.Contains(l, "oauth session expired"), strings.Contains(l, "not logged"), strings.Contains(l, "login"):
		return "Authentication is unavailable or expired. Sign in to the installed agent and resume."
	case strings.Contains(l, "policy"), strings.Contains(l, "organization"):
		return "The provider or organization policy blocked this action. Review the provider settings."
	case strings.Contains(l, "rate limit"), strings.Contains(l, "429"):
		return "The provider usage limit was reached. Wait for it to reset, then resume."
	default:
		return s
	}
}
