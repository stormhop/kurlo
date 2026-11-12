//go:build linux

package api

import (
	"context"
	"net/url"
	"time"

	"github.com/godbus/dbus/v5"
)

var showItemInFileManager = func(target string) error {
	conn, err := dbus.SessionBus()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	uri := (&url.URL{Scheme: "file", Path: target}).String()
	return conn.Object("org.freedesktop.FileManager1", "/org/freedesktop/FileManager1").
		CallWithContext(ctx, "org.freedesktop.FileManager1.ShowItems", 0, []string{uri}, "").Err
}
