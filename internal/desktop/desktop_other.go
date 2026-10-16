//go:build !darwin && !windows

package desktop

import "errors"

func Reveal(path string) error { return errors.New("Unsupported platform") }
