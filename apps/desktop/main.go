package main

import (
	"embed"
	"fmt"
	"os"
	"runtime"

	"github.com/stormhop/kurlo/apps/desktop/internal/api"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	winopts "github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	var previousInstance int
	os.Args, previousInstance = api.TakeRelaunchWait(os.Args)
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "--version", "-version", "version":
			fmt.Println(api.VersionLine())
			os.Exit(0)
		case "--diagnostics", "-diagnostics", "diagnostics":
			fmt.Print(api.DiagnosticsReport())
			os.Exit(0)
		}
	}
	if len(os.Args) >= 2 && os.Args[1] == "git-credential" {
		os.Exit(api.RunGitCredentialHelper(os.Args[2:]))
	}
	if len(os.Args) >= 2 && os.Args[1] == "run" {
		os.Exit(api.RunCLI(os.Args[2:]))
	}
	if len(os.Args) >= 2 && os.Args[1] == "load" {
		os.Exit(api.RunLoadCLI(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) >= 2 && os.Args[1] == "mcp" {
		os.Exit(api.RunMCPServer(os.Args[2:]))
	}

	api.WaitForPreviousInstance(previousInstance)

	if path, err := api.InstallLogFile(); err != nil {
		fmt.Fprintf(os.Stderr, "kurlo: could not open the log file at %s: %v\n", path, err)
	}

	app := api.NewApp()
	err := wails.Run(buildAppOptions(app, assets))
	if err != nil {
		println("Error:", err.Error())
	}
}

const kurloSingleInstanceID = "dev.kurlo.app"

func hideWindowOnClose(goos string) bool {
	return goos == "darwin"
}

func buildAppOptions(app *api.App, frontendAssets embed.FS) *options.App {
	bgR, bgG, bgB, bgA := api.InitialWindowBackgroundRGBA()

	return &options.App{
		Title:             "Kurlo",
		Width:             1280,
		Height:            820,
		MinWidth:          1120,
		MinHeight:         680,
		HideWindowOnClose: hideWindowOnClose(runtime.GOOS),
		Frameless:         runtime.GOOS == "windows",
		AssetServer: &assetserver.Options{
			Assets: frontendAssets,
		},
		BackgroundColour: options.NewRGBA(bgR, bgG, bgB, bgA),
		Menu:             buildMenu(app),
		OnStartup:        app.Startup,
		OnBeforeClose:    app.BeforeClose,
		OnShutdown:       app.Shutdown,
		SingleInstanceLock: newSingleInstanceLock(func() {
			app.Show()
		}),
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
				HideTitleBar:               false,
				FullSizeContent:            true,
				UseToolbar:                 false,
			},
			WebviewIsTransparent: true,
			WindowIsTranslucent:  false,
		},
		Windows: buildWindowsOptions(api.InitialWindowResolvedTheme()),
		Bind: []interface{}{
			app,
		},
	}
}

func newSingleInstanceLock(showExistingWindow func()) *options.SingleInstanceLock {
	if showExistingWindow == nil {
		showExistingWindow = func() {}
	}
	return &options.SingleInstanceLock{
		UniqueId: kurloSingleInstanceID,
		OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
			showExistingWindow()
		},
	}
}

func buildWindowsOptions(resolvedTheme string) *winopts.Options {
	theme := winopts.Dark
	if resolvedTheme == "light" {
		theme = winopts.Light
	}
	return &winopts.Options{
		Theme: theme,
		CustomTheme: &winopts.ThemeSettings{
			DarkModeTitleBar:           winopts.RGB(12, 12, 14),
			DarkModeTitleBarInactive:   winopts.RGB(17, 17, 19),
			DarkModeTitleText:          winopts.RGB(236, 236, 239),
			DarkModeTitleTextInactive:  winopts.RGB(133, 133, 142),
			DarkModeBorder:             winopts.RGB(45, 45, 50),
			DarkModeBorderInactive:     winopts.RGB(34, 34, 38),
			LightModeTitleBar:          winopts.RGB(247, 247, 248),
			LightModeTitleBarInactive:  winopts.RGB(241, 241, 243),
			LightModeTitleText:         winopts.RGB(23, 23, 26),
			LightModeTitleTextInactive: winopts.RGB(107, 107, 116),
			LightModeBorder:            winopts.RGB(223, 223, 228),
			LightModeBorderInactive:    winopts.RGB(236, 236, 239),
		},
	}
}

func viewMenu(app *api.App) *menu.MenuItem {
	return menu.SubMenu("View", menu.NewMenuFromItems(
		menu.Text("Actual Size", keys.CmdOrCtrl("0"), func(_ *menu.CallbackData) { app.MenuZoom("reset") }),
		menu.Text("Zoom In", keys.CmdOrCtrl("="), func(_ *menu.CallbackData) { app.MenuZoom("in") }),
		menu.Text("Zoom Out", keys.CmdOrCtrl("-"), func(_ *menu.CallbackData) { app.MenuZoom("out") }),
	))
}

func buildMenu(app *api.App) *menu.Menu {
	return buildMenuFor(app, runtime.GOOS)
}

func buildMenuFor(app *api.App, goos string) *menu.Menu {
	if goos == "darwin" {
		return menu.NewMenuFromItems(
			menu.AppMenu(),
			menu.EditMenu(),
			viewMenu(app),
			menu.WindowMenu(),
		)
	}

	appMenu := menu.NewMenu()

	kurlo := appMenu.AddSubmenu("Kurlo")
	kurlo.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) { app.Quit() })
	appMenu.Append(viewMenu(app))

	return appMenu
}
