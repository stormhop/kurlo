//go:build !darwin

package api

import "errors"

func exchangePaths(string, string) error {
	return errors.New("atomic path exchange is not supported on this platform")
}
