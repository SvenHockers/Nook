//go:build !darwin && !windows

package process

import "errors"

func Identity(pid int) (string, error) { return "", nil }
func Recover(pid int, birth string) error {
	if pid > 0 && birth != "" {
		return errors.New("Process recovery is unsupported on this platform")
	}
	return nil
}
