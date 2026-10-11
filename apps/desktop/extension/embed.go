package extension

import "embed"

//go:embed manifest.json manifest.firefox.json background.js popup.html popup.js icons
var Files embed.FS
