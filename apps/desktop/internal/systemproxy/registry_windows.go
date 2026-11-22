//go:build windows

package systemproxy

import (
	"errors"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const internetSettings = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

type windowsRegistry struct{}

func (windowsRegistry) Get() (string, bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, internetSettings, registry.QUERY_VALUE)
	if err != nil {
		return "", false, err
	}
	defer key.Close()
	value, _, err := key.GetStringValue("AutoConfigURL")
	if errors.Is(err, registry.ErrNotExist) {
		return "", false, nil
	}
	return value, err == nil, err
}

func (windowsRegistry) Set(url string, present bool) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, internetSettings, registry.SET_VALUE)
	if err != nil {
		return err
	}
	if present {
		err = key.SetStringValue("AutoConfigURL", url)
	} else if err = key.DeleteValue("AutoConfigURL"); errors.Is(err, registry.ErrNotExist) {
		err = nil
	}
	key.Close()
	if err != nil {
		return err
	}
	notifySettingsChanged()
	return nil
}

var internetSetOption = windows.NewLazySystemDLL("wininet.dll").NewProc("InternetSetOptionW")

func notifySettingsChanged() {
	const settingsChanged, refresh = 39, 37
	internetSetOption.Call(0, settingsChanged, 0, 0)
	internetSetOption.Call(0, refresh, 0, 0)
}
