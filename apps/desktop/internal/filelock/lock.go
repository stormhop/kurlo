package filelock

import (
	"context"
	"errors"
	"os"
	"time"
)

var ErrBusy = errors.New("file is locked")

func Acquire(ctx context.Context, file *os.File) error {
	for {
		err := Try(file)
		if !errors.Is(err, ErrBusy) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
