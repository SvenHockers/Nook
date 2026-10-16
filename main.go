// Nook's Go runtime is a private stdio sidecar owned by the Tauri shell.
package main

import (
	"flag"
	"fmt"
	"nook/internal/ipc"
	"nook/internal/provider"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--permission-host" {
		if err := provider.PermissionHost(os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
		return
	}
	root := flag.String("data-dir", "", "Local Nook data directory")
	rpc := flag.Bool("rpc", false, "Serve the desktop stdio protocol")
	flag.Parse()
	if !*rpc {
		fmt.Fprintln(os.Stderr, "This is Nook's backend. Open the Nook desktop application.")
		os.Exit(2)
	}
	if *root == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		*root = filepath.Join(config, "Nook")
	}
	exe, err := os.Executable()
	if err == nil {
		err = ipc.Serve(os.Stdin, os.Stdout, *root, exe)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
