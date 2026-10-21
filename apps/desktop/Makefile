SHELL := /bin/sh

ROOT_DIR    := $(shell git -C $(CURDIR) rev-parse --show-toplevel 2>/dev/null || pwd)
DESKTOP_DIR := $(ROOT_DIR)/apps/desktop
APP_NAME    := Kurlo
WAILS_VERSION := v2.16.0
WAILS_CMD   := $(shell command -v wails 2>/dev/null || printf '%s' 'go run github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION)')
GO_ENV      := GOCACHE=$(ROOT_DIR)/.cache/go-build
DEV_ENV     := $(GO_ENV) KURLO_DISABLE_KEYCHAIN=1

VERSION     := $(shell git describe --tags --always --dirty 2>/dev/null | sed 's/^v//')
ifeq ($(VERSION),)
VERSION     := dev
endif


UPDATE_REPO  ?= stormhop/kurlo
LDFLAGS     := -X 'github.com/stormhop/kurlo/apps/desktop/internal/api.appVersion=$(VERSION)' \
               -X 'github.com/stormhop/kurlo/apps/desktop/internal/api.githubRepo=$(UPDATE_REPO)'

MAC_APP     := $(DESKTOP_DIR)/build/bin/$(APP_NAME).app
MAC_DMG     := $(DESKTOP_DIR)/build/bin/kurlo-$(VERSION)-darwin-universal.dmg
LINUX_BIN   := $(DESKTOP_DIR)/build/bin/kurlo
WIN_ARCH    ?= amd64
WIN_EXE     := $(DESKTOP_DIR)/build/bin/kurlo-$(WIN_ARCH)-installer.exe
WIN_MSIX    := $(DESKTOP_DIR)/build/bin/kurlo-$(VERSION)-windows-$(WIN_ARCH).msix

HOST_OS := $(shell uname -s 2>/dev/null || echo Windows_NT)
POWERSHELL := $(shell command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null || printf '%s' 'pwsh')

MSIX_IDENTITY_NAME ?= dev.kurlo.app
MSIX_PUBLISHER ?= CN=Kurlo
MSIX_PUBLISHER_DISPLAY_NAME ?= Kurlo
MSIX_CERT_PATH ?=
MSIX_CERT_PASSWORD ?=
MSIX_TIMESTAMP_URL ?=

.PHONY: help dev dev-go dev-run frontend install tidy check test build build-desktop build-macos build-macos-dmg build-windows build-windows-msix build-linux build-all build-frontend open clean wails-install version

help:
	@printf '%s\n' 'Available targets:'
	@printf '  %-18s %s\n' 'make dev' 'Run Wails dev mode'
	@printf '  %-18s %s\n' 'make frontend' 'Run only Svelte/Vite frontend'
	@printf '  %-18s %s\n' 'make install' 'Install npm deps and tidy Go deps'
	@printf '  %-18s %s\n' 'make check' 'Run frontend typecheck and Go tests'
	@printf '  %-18s %s\n' 'make build' 'Build desktop app for the current platform'
	@printf '  %-18s %s\n' 'make build-macos-dmg' 'Build universal macOS app and branded DMG (requires create-dmg)'
	@printf '  %-18s %s\n' 'make build-windows' 'Build Windows NSIS installer and MSIX package (WIN_ARCH=amd64|arm64)'

version:
	@echo $(VERSION)

dev:
	cd $(DESKTOP_DIR) && $(DEV_ENV) $(WAILS_CMD) dev

dev-go:
	cd $(DESKTOP_DIR) && $(DEV_ENV) go run github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION) dev

dev-run: dev

frontend:
	cd $(ROOT_DIR) && npm run frontend:dev

install:
	cd $(ROOT_DIR) && npm install
	cd $(DESKTOP_DIR) && $(GO_ENV) go mod tidy

tidy:
	cd $(DESKTOP_DIR) && $(GO_ENV) go mod tidy

check:
	cd $(ROOT_DIR) && npm run frontend:check
	cd $(ROOT_DIR) && $(GO_ENV) go test ./apps/desktop/...

test:
	cd $(ROOT_DIR) && $(GO_ENV) go test ./apps/desktop/...

build: build-desktop

build-desktop:
	cd $(DESKTOP_DIR) && $(GO_ENV) $(WAILS_CMD) build -ldflags "$(LDFLAGS)"

build-macos:
	cd $(DESKTOP_DIR) && $(GO_ENV) $(WAILS_CMD) build -platform darwin/universal -ldflags "$(LDFLAGS)"

build-macos-dmg: build-macos
	$(DESKTOP_DIR)/build/darwin/make-dmg.sh "$(MAC_APP)" "$(MAC_DMG)" "Kurlo $(VERSION)"

build-windows:
	cd $(DESKTOP_DIR) && $(GO_ENV) $(WAILS_CMD) build -platform windows/$(WIN_ARCH) -nsis -ldflags "$(LDFLAGS)"
	$(MAKE) build-windows-msix

build-windows-msix:
	cd $(DESKTOP_DIR) && "$(POWERSHELL)" -NoProfile -ExecutionPolicy Bypass -File build/windows/package-msix.ps1 \
		-Version "$(VERSION)" \
		-Architecture "$(WIN_ARCH)" \
		-IdentityName "$(MSIX_IDENTITY_NAME)" \
		-Publisher "$(MSIX_PUBLISHER)" \
		-PublisherDisplayName "$(MSIX_PUBLISHER_DISPLAY_NAME)" \
		-OutputPath "$(WIN_MSIX)" \
		-CertificatePath "$(MSIX_CERT_PATH)" \
		-CertificatePassword "$(MSIX_CERT_PASSWORD)" \
		-TimestampUrl "$(MSIX_TIMESTAMP_URL)"

build-linux:
	cd $(DESKTOP_DIR) && $(GO_ENV) $(WAILS_CMD) build -platform linux/amd64 -ldflags "$(LDFLAGS)"

build-all: build-macos build-windows build-linux

build-frontend:
	cd $(ROOT_DIR) && npm run frontend:build

open:
ifeq ($(HOST_OS),Darwin)
	open "$(MAC_APP)"
else ifeq ($(HOST_OS),Linux)
	xdg-open "$(LINUX_BIN)"
else
	start "" "$(WIN_EXE)"
endif

clean:
	rm -rf "$(DESKTOP_DIR)/build/bin" \
	       "$(DESKTOP_DIR)/frontend/dist/assets" \
	       "$(DESKTOP_DIR)/frontend/dist/index.html"

wails-install:
	$(GO_ENV) go install github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION)
