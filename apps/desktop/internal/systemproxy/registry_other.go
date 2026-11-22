//go:build !windows

package systemproxy

type windowsRegistry struct{}

func (windowsRegistry) Get() (string, bool, error) { return "", false, ErrUnsupported }

func (windowsRegistry) Set(string, bool) error { return ErrUnsupported }
