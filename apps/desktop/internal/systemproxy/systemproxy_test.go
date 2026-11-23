package systemproxy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeMac struct {
	urls     map[string]string
	enabled  map[string]bool
	needRoot bool
	calls    []string
	elevated []string
}

func (f *fakeMac) run(_ context.Context, name string, args ...string) (string, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	switch args[0] {
	case "-listallnetworkservices":
		return "An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*Bluetooth PAN\nUSB LAN", nil
	case "-getautoproxyurl":
		url := f.urls[args[1]]
		if url == "" {
			url = "(null)"
		}
		state := "No"
		if f.enabled[args[1]] {
			state = "Yes"
		}
		return "URL: " + url + "\nEnabled: " + state, nil
	case "-setautoproxyurl", "-setautoproxystate":
		if f.needRoot {
			return "", errors.New("** Error: Command requires admin privileges.")
		}
		f.apply(args)
		return "", nil
	}
	return "", errors.New("unexpected " + args[0])
}

func (f *fakeMac) apply(args []string) {
	if args[0] == "-setautoproxyurl" {
		f.urls[args[1]] = args[2]
		f.enabled[args[1]] = true
	} else {
		f.enabled[args[1]] = args[2] == "on"
	}
}

func (f *fakeMac) elevate(_ context.Context, name string, args ...string) (string, error) {
	f.elevated = append(f.elevated, args[len(args)-1])
	for _, command := range strings.Split(args[len(args)-1], " && ") {
		parts := strings.Split(command, "' '")
		for i := range parts {
			parts[i] = strings.Trim(parts[i], "'")
		}
		f.apply(parts[1:])
	}
	return "", nil
}

func TestMacEnableRestoresOnlyItsOwnSettings(t *testing.T) {
	for _, needRoot := range []bool{false, true} {
		mac := &fakeMac{urls: map[string]string{"USB LAN": "http://corp/proxy.pac"}, enabled: map[string]bool{"USB LAN": true}, needRoot: needRoot}
		path := filepath.Join(t.TempDir(), "system-proxy.json")
		m := &Manager{Path: path, GOOS: "darwin", Run: mac.run, Elevate: mac.elevate}
		pac := "http://127.0.0.1:9090/proxy.pac"
		if err := m.Enable(context.Background(), pac); err != nil {
			t.Fatal(err)
		}
		if !m.Active() || mac.urls["Wi-Fi"] != pac || mac.urls["USB LAN"] != pac || !mac.enabled["Wi-Fi"] || mac.urls["Bluetooth PAN"] != "" {
			t.Fatal(mac.urls, mac.enabled)
		}
		if needRoot && (len(mac.elevated) != 1 || !strings.Contains(mac.elevated[0], "'/usr/sbin/networksetup' '-setautoproxyurl' 'Wi-Fi'")) {
			t.Fatal(mac.elevated)
		}
		mac.needRoot = false
		mac.urls["USB LAN"] = "http://user-changed/proxy.pac"
		if err := m.Recover(context.Background()); err != nil {
			t.Fatal(err)
		}
		if m.Active() || mac.enabled["Wi-Fi"] || mac.urls["USB LAN"] != "http://user-changed/proxy.pac" || !mac.enabled["USB LAN"] {
			t.Fatal(mac.urls, mac.enabled)
		}
	}
}

func TestMacRestoresPreviousPAC(t *testing.T) {
	mac := &fakeMac{urls: map[string]string{"Wi-Fi": "http://corp/proxy.pac"}, enabled: map[string]bool{"Wi-Fi": false}}
	m := &Manager{Path: filepath.Join(t.TempDir(), "backup.json"), GOOS: "darwin", Run: mac.run, Elevate: mac.elevate}
	if err := m.Enable(context.Background(), "http://127.0.0.1:9191/proxy.pac"); err != nil {
		t.Fatal(err)
	}
	if err := m.Enable(context.Background(), "http://127.0.0.1:9292/proxy.pac"); err != nil {
		t.Fatal(err)
	}
	if err := m.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if mac.urls["Wi-Fi"] != "http://corp/proxy.pac" || mac.enabled["Wi-Fi"] {
		t.Fatal(mac.urls, mac.enabled)
	}
}

type fakeWindows struct {
	url     string
	present bool
}

func (f *fakeWindows) Get() (string, bool, error) { return f.url, f.present, nil }
func (f *fakeWindows) Set(url string, present bool) error {
	f.url, f.present = url, present
	return nil
}

func TestWindowsAndGnome(t *testing.T) {
	win := &fakeWindows{}
	m := &Manager{Path: filepath.Join(t.TempDir(), "w.json"), GOOS: "windows", Windows: win}
	if err := m.Enable(context.Background(), "http://127.0.0.1:9090/proxy.pac"); err != nil || win.url != "http://127.0.0.1:9090/proxy.pac" {
		t.Fatal(win, err)
	}
	if err := m.Recover(context.Background()); err != nil || win.present || win.url != "" {
		t.Fatal(win, err)
	}
	settings := map[string]string{"mode": "'manual'", "autoconfig-url": "''"}
	gnome := func(_ context.Context, name string, args ...string) (string, error) {
		if args[0] == "get" {
			return settings[args[2]], nil
		}
		settings[args[2]] = "'" + args[3] + "'"
		return "", nil
	}
	m = &Manager{Path: filepath.Join(t.TempDir(), "g.json"), GOOS: "linux", Run: gnome}
	if err := m.Enable(context.Background(), "http://127.0.0.1:9090/proxy.pac"); err != nil || settings["mode"] != "'auto'" {
		t.Fatal(settings, err)
	}
	if err := m.Recover(context.Background()); err != nil || settings["mode"] != "'manual'" || settings["autoconfig-url"] != "''" {
		t.Fatal(settings, err)
	}
	missing := &Manager{Path: filepath.Join(t.TempDir(), "x.json"), GOOS: "linux", Run: func(context.Context, string, ...string) (string, error) { return "", errors.New("not found") }}
	if err := missing.Enable(context.Background(), "http://x/proxy.pac"); !errors.Is(err, ErrUnsupported) || missing.Active() {
		t.Fatal(err)
	}
}

func TestDamagedBackupIsDiscarded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.json")
	os.WriteFile(path, []byte("{"), 0o600)
	m := &Manager{Path: path, GOOS: "darwin"}
	if err := m.Recover(context.Background()); err != nil || m.Active() {
		t.Fatal(err)
	}
}

func TestSupported(t *testing.T) {
	gnome := func(context.Context, string, ...string) (string, error) { return "'none'", nil }
	missing := func(context.Context, string, ...string) (string, error) { return "", errors.New("No such schema") }
	cases := []struct {
		m    Manager
		want bool
	}{{Manager{GOOS: "darwin"}, true}, {Manager{GOOS: "windows"}, true}, {Manager{GOOS: "linux", Run: gnome}, true}, {Manager{GOOS: "linux", Run: missing}, false}, {Manager{GOOS: "freebsd"}, false}}
	for _, c := range cases {
		if c.m.Supported(context.Background()) != c.want {
			t.Fatal(c.m.GOOS, c.want)
		}
	}
}

func TestMacRecoveryRespectsOwnerAndManualEdits(t *testing.T) {
	const original = "http://original/route.pac"
	mac := &fakeMac{urls: map[string]string{"Wi-Fi": original}, enabled: map[string]bool{"Wi-Fi": true}}
	base := Manager{Path: filepath.Join(t.TempDir(), "backup.json"), GOOS: "darwin", Run: mac.run, Elevate: mac.elevate}
	first, second, startup := base, base, base
	ctx := context.Background()
	if err := first.Enable(ctx, "http://first/proxy.pac"); err != nil {
		t.Fatal(err)
	}
	if err := second.Enable(ctx, "http://second/proxy.pac"); err != nil {
		t.Fatal(err)
	}
	for _, other := range []*Manager{&first, &startup} {
		if err := other.Recover(ctx); err != nil || other.Active() || !second.Active() || mac.urls["Wi-Fi"] != "http://second/proxy.pac" {
			t.Fatal(mac.urls, err)
		}
	}
	mac.urls["Wi-Fi"] += "?profile=work"
	mac.enabled["USB LAN"] = false
	if err := second.Recover(ctx); err != nil || mac.urls["Wi-Fi"] != "http://second/proxy.pac?profile=work" || mac.enabled["USB LAN"] {
		t.Fatal(mac.urls, mac.enabled, err)
	}
}

func TestMacRecoveryRetriesReadAndPartialRestore(t *testing.T) {
	mac := &fakeMac{urls: map[string]string{"Wi-Fi": "http://old/pac"}, enabled: map[string]bool{"Wi-Fi": false}}
	m := Manager{Path: filepath.Join(t.TempDir(), "backup.json"), GOOS: "darwin", Run: mac.run, Elevate: mac.elevate}
	ctx := context.Background()
	if err := m.Enable(ctx, "http://recorder/pac"); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"-getautoproxyurl", "-setautoproxystate"} {
		m.Run = func(ctx context.Context, name string, args ...string) (string, error) {
			if args[0] == command && args[1] == "Wi-Fi" {
				return "", errors.New("temporary failure")
			}
			return mac.run(ctx, name, args...)
		}
		if err := m.Recover(ctx); err == nil || !m.Active() {
			t.Fatal(command, err)
		}
	}
	m.Run = mac.run
	if err := m.Recover(ctx); err != nil || mac.urls["Wi-Fi"] != "http://old/pac" || mac.enabled["Wi-Fi"] || m.Active() {
		t.Fatal(mac.urls, mac.enabled, err)
	}
}

func TestGnomeRecoveryRetriesAndRespectsManualMode(t *testing.T) {
	for _, action := range []string{"read error", "write error", "manual edit", "abandoned lease"} {
		t.Run(action, func(t *testing.T) {
			settings := map[string]string{"mode": "manual", "autoconfig-url": "http://original/pac"}
			fail := ""
			runner := func(_ context.Context, _ string, args ...string) (string, error) {
				if args[0]+" "+args[2] == fail {
					return "", errors.New("temporary settings failure")
				}
				if args[0] == "get" {
					return "'" + settings[args[2]] + "'", nil
				}
				settings[args[2]] = args[3]
				return "", nil
			}
			ctx := context.Background()
			m := &Manager{Path: filepath.Join(t.TempDir(), "backup.json"), GOOS: "linux", Run: runner}
			if err := m.Enable(ctx, "http://recorder/pac"); err != nil {
				t.Fatal(err)
			}
			wantMode, wantURL := "manual", "http://original/pac"
			switch action {
			case "read error":
				fail = "get autoconfig-url"
			case "write error":
				fail = "set mode"
			case "manual edit":
				wantMode, wantURL = "none", "http://recorder/pac"
				settings["mode"] = "none"
			case "abandoned lease":
				if err := m.currentLease().file.Close(); err != nil {
					t.Fatal(err)
				}
				m = &Manager{Path: m.Path, GOOS: "linux", Run: runner}
			}
			if fail != "" {
				if err := m.Recover(ctx); err == nil || !m.Active() {
					t.Fatal(err)
				}
				fail = ""
			}
			if err := m.Recover(ctx); err != nil || settings["mode"] != wantMode || settings["autoconfig-url"] != wantURL {
				t.Fatal(settings, err)
			}
		})
	}
}
