//go:build !linux

package api

import "errors"

var showItemInFileManager = func(string) error {
	return errors.ErrUnsupported
}
