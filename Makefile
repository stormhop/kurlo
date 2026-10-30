SHELL := /bin/sh

ROOT_DIR      := $(shell git -C $(CURDIR) rev-parse --show-toplevel 2>/dev/null || pwd)
DESKTOP_DIR   := $(ROOT_DIR)/apps/desktop
APP_NAME      := Kurlo
WAILS_VERSION := v2.16.0
WAILS_CMD     := $(shell command -v wails 2>/dev/null || printf '%s' 'go run github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION)')
GO_ENV        := GOCACHE=$(ROOT_DIR)/.cache/go-build
DEV_ENV       := $(GO_ENV) KURLO_DISABLE_KEYCHAIN=1

VERSION := $(shell git describe --tags --always --dirty 2>/dev/null | sed 's/^v//')
ifeq ($(VERSION),)
VERSION := dev
endif
UPDATE_REPO ?= stormhop/kurlo
LDFLAGS := -X 'github.com/stormhop/kurlo/apps/desktop/internal/api.appVersion=$(VERSION)' \
           -X 'github.com/stormhop/kurlo/apps/desktop/internal/api.githubRepo=$(UPDATE_REPO)'

MAC_APP   := $(DESKTOP_DIR)/build/bin/$(APP_NAME).app
LINUX_BIN := $(DESKTOP_DIR)/build/bin/kurlo
WIN_ARCH  ?= amd64
WIN_EXE   := $(DESKTOP_DIR)/build/bin/kurlo-$(WIN_ARCH)-installer.exe
WIN_MSIX  := $(DESKTOP_DIR)/build/bin/kurlo-$(VERSION)-windows-$(WIN_ARCH).msix

HOST_OS := $(shell uname -s 2>/dev/null || echo Windows_NT)
LINUX_WAILS_TAGS := -tags webkit2_41
HOST_WAILS_TAGS := $(if $(filter Linux,$(HOST_OS)),$(LINUX_WAILS_TAGS),)
POWERSHELL := $(shell command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null || printf '%s' 'pwsh')

MSIX_IDENTITY_NAME ?= dev.kurlo.app
MSIX_PUBLISHER ?= CN=Kurlo
MSIX_PUBLISHER_DISPLAY_NAME ?= Kurlo
MSIX_CERT_PATH ?=
MSIX_CERT_PASSWORD ?=
MSIX_TIMESTAMP_URL ?=


_LAST_TAG   := $(shell git describe --tags --abbrev=0 --exclude '*-*' 2>/dev/null || echo v0.0.0)
_LAST_VER   := $(patsubst v%,%,$(_LAST_TAG))
_VER_PARTS  := $(subst ., ,$(_LAST_VER))
_V_MAJOR    := $(word 1,$(_VER_PARTS))
_V_MINOR    := $(word 2,$(_VER_PARTS))
_V_PATCH    := $(word 3,$(_VER_PARTS))
_NEXT_PATCH := $(shell printf '%d' $$(( $(_V_PATCH) + 1 )))
_NEXT_MINOR := $(shell printf '%d' $$(( $(_V_MINOR) + 1 )))
_NEXT_MAJOR := $(shell printf '%d' $$(( $(_V_MAJOR) + 1 )))

GITHUB_REPO := $(shell git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]\(.*\)\.git|\1|;s|.*github.com[:/]\(.*\)$$|\1|')

.PHONY: help version dev dev-go dev-run frontend install tidy check test \
        build build-desktop build-macos build-windows build-windows-msix build-linux build-all build-frontend \
        open clean wails-install bindings screenshots readme-screenshot test-extension mcp-schemas \
        release release-patch release-minor release-major _do-release _guard-clean \
        update-keygen update-sign \
        release-mac-local _do-release-mac-local release-mac-publish

help:
	@printf '%s\n' 'Available targets:'
	@printf '  %-24s %s\n' 'make dev' 'Run Wails dev mode'
	@printf '  %-24s %s\n' 'make frontend' 'Run only Svelte/Vite frontend'
	@printf '  %-24s %s\n' 'make install' 'Install npm deps and tidy Go deps'
	@printf '  %-24s %s\n' 'make check' 'Run frontend typecheck and Go tests'
	@printf '  %-24s %s\n' 'make test-extension' 'Drive the cookie sync extension in a real browser'
	@printf '  %-24s %s\n' 'make mcp-schemas' 'Refresh the MCP spec schemas the server is checked against'
	@printf '  %-24s %s\n' 'make build' 'Build desktop app for the current platform'
	@printf '  %-24s %s\n' 'make build-windows' 'Build Windows NSIS installer and MSIX package (WIN_ARCH=amd64|arm64)'
	@printf '%s\n' ''
	@printf '%s\n' 'Release targets (current: $(_LAST_TAG)):'
	@printf '  %-24s %s\n' 'make release' 'Bump patch and release  ($(_LAST_TAG) → v$(_V_MAJOR).$(_V_MINOR).$(_NEXT_PATCH))'
	@printf '  %-24s %s\n' 'make release-minor' 'Bump minor and release  ($(_LAST_TAG) → v$(_V_MAJOR).$(_NEXT_MINOR).0)'
	@printf '  %-24s %s\n' 'make release-major' 'Bump major and release  ($(_LAST_TAG) → v$(_NEXT_MAJOR).0.0)'
	@printf '  %-24s %s\n' 'make release v=1.2.3' 'Release an explicit version'
	@printf '%s\n' ''
	@printf '%s\n' 'Local release targets (build + publish without CI):'
	@printf '  %-30s %s\n' 'make release-mac-local' 'Build, sign, and publish a macOS-only release directly'
	@printf '  %-30s %s\n' 'make release-mac-publish' 'Re-publish artifacts already in release/ (retry on network failure)'
	@printf '%s\n' ''
	@printf '%s\n' 'Update-signing targets:'
	@printf '  %-24s %s\n' 'make update-keygen' 'Generate a new minisign keypair for signing updates'
	@printf '  %-24s %s\n' 'make update-sign' 'Sign every artifact in apps/desktop/build/bin/'

version:
	@echo $(VERSION)







update-keygen:
	@if ! command -v minisign >/dev/null 2>&1; then \
		printf '\033[31mError:\033[0m minisign is not installed.\n'; \
		printf '  macOS:  brew install minisign\n'; \
		printf '  Linux:  apt-get install minisign  (or build from https://jedisct1.github.io/minisign/)\n'; \
		exit 1; \
	fi
	@if [ -f "$(ROOT_DIR)/update-signing-key" ]; then \
		printf '\033[31mError:\033[0m $(ROOT_DIR)/update-signing-key already exists. Refusing to overwrite.\n'; \
		exit 1; \
	fi
	minisign -G -p "$(ROOT_DIR)/update-signing-key.pub" -s "$(ROOT_DIR)/update-signing-key"
	@printf '\n\033[32m✓\033[0m Keypair generated.\n'
	@printf '\nPublic key — embed this into release builds via ldflags:\n'
	@tail -1 "$(ROOT_DIR)/update-signing-key.pub"
	@printf '\n  -X "github.com/stormhop/kurlo/apps/desktop/internal/api.updatePublicKey=$$(tail -1 $(ROOT_DIR)/update-signing-key.pub)"\n'

update-sign:
	@if ! command -v minisign >/dev/null 2>&1; then \
		printf '\033[31mError:\033[0m minisign is not installed. See "make update-keygen" output for install hints.\n'; \
		exit 1; \
	fi
	@if [ ! -f "$(ROOT_DIR)/update-signing-key" ]; then \
		printf '\033[31mError:\033[0m $(ROOT_DIR)/update-signing-key not found. Run "make update-keygen" first.\n'; \
		exit 1; \
	fi
	@count=0; \
	for asset in "$(DESKTOP_DIR)/build/bin/Kurlo.app/Contents/MacOS/kurlo" \
	             "$(DESKTOP_DIR)/build/bin/kurlo" \
	             "$(DESKTOP_DIR)/build/bin/kurlo-amd64-installer.exe"; do \
		if [ -f "$$asset" ]; then \
			printf 'Signing %s\n' "$$asset"; \
			minisign -S -s "$(ROOT_DIR)/update-signing-key" -m "$$asset"; \
			count=$$((count + 1)); \
		fi; \
	done; \
	if [ "$$count" = 0 ]; then \
		printf '\033[31mError:\033[0m no built artifacts found in $(DESKTOP_DIR)/build/bin — run "make build" first.\n'; \
		exit 1; \
	fi








release: _guard-clean
ifdef v
	@$(MAKE) _do-release _NEXT=$(v)
else
	@$(MAKE) _do-release _NEXT=$(_V_MAJOR).$(_V_MINOR).$(_NEXT_PATCH)
endif

release-patch: _guard-clean
	@$(MAKE) _do-release _NEXT=$(_V_MAJOR).$(_V_MINOR).$(_NEXT_PATCH)

release-minor: _guard-clean
	@$(MAKE) _do-release _NEXT=$(_V_MAJOR).$(_NEXT_MINOR).0

release-major: _guard-clean
	@$(MAKE) _do-release _NEXT=$(_NEXT_MAJOR).0.0

_guard-clean:
	@if [ -n "$$(git status --porcelain)" ]; then \
	  printf '\033[31mError:\033[0m working tree is dirty — commit or stash changes first.\n'; \
	  git status --short; \
	  exit 1; \
	fi

_do-release:
	@if ! printf '%s' "$(_NEXT)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$$'; then \
		printf '\033[31mError:\033[0m "%s" is not a release version (expected 1.2.3 or 1.2.3-rc.1).\n' "$(_NEXT)"; \
		exit 1; \
	fi
	@printf '\033[90mCurrent:\033[0m  $(_LAST_TAG)\n'
	@printf '\033[32mNext:\033[0m     v$(_NEXT)\n'
	@if [ -n "$(NOTES)" ]; then printf '\033[90mNotes:\033[0m    %s\n' "$(NOTES)"; fi
	@printf 'Tag and push? [y/N] '; \
	  read ans; \
	  [ "$$ans" = y ] || [ "$$ans" = Y ] || { echo 'Aborted.'; exit 1; }
	@if [ -n "$(NOTES)" ]; then \
	  BULLETS=$$(printf '%s' "$(NOTES)" | tr '+' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$$//; /^$$/d; s/^/- /'); \
	  printf '%s\n' "$$BULLETS" | git tag -a "v$(_NEXT)" -F -; \
	else \
	  git tag -a "v$(_NEXT)" -m "Release v$(_NEXT)"; \
	fi
	git push origin "v$(_NEXT)"
	@printf '\033[32m✓\033[0m Tagged v$(_NEXT) and pushed — GitHub Actions is building the release.\n'
	@printf '  https://github.com/$(GITHUB_REPO)/actions\n'











release-mac-local: _guard-clean
ifdef v
	@$(MAKE) _do-release-mac-local _NEXT=$(v)
else
	@$(MAKE) _do-release-mac-local _NEXT=$(_V_MAJOR).$(_V_MINOR).$(_NEXT_PATCH)
endif

_do-release-mac-local:
	@if ! printf '%s' "$(_NEXT)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$$'; then \
		printf '\033[31mError:\033[0m "%s" is not a release version (expected 1.2.3 or 1.2.3-rc.1).\n' "$(_NEXT)"; \
		exit 1; \
	fi
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		printf '\033[31mError:\033[0m release-mac-local must run on macOS.\n'; \
		exit 1; \
	fi
	@if ! command -v gh >/dev/null 2>&1; then \
		printf '\033[31mError:\033[0m gh CLI is not installed. brew install gh && gh auth login\n'; \
		exit 1; \
	fi
	@printf '\033[90mCurrent:\033[0m  $(_LAST_TAG)\n'
	@printf '\033[32mNext:\033[0m     v$(_NEXT) \033[90m(mac-only, local)\033[0m\n'
	@if [ -f "$(ROOT_DIR)/update-signing-key" ]; then \
		printf '\033[90mSigning:\033[0m  enabled (update-signing-key found)\n'; \
	else \
		printf '\033[90mSigning:\033[0m  disabled (no update-signing-key — SHA256 only)\n'; \
	fi
	@if [ -n "$(NOTES)" ]; then printf '\033[90mNotes:\033[0m    %s\n' "$(NOTES)"; fi
	@printf '\033[90mTarget:\033[0m   $(UPDATE_REPO) release v$(_NEXT) (will overwrite if it already exists)\n'
	@printf 'Build and publish? [y/N] '; \
	  read ans; \
	  [ "$$ans" = y ] || [ "$$ans" = Y ] || { echo 'Aborted.'; exit 1; }
	@$(MAKE) _exec-release-mac-local _NEXT=$(_NEXT)



_exec-release-mac-local:
	@set -e; \
	WORK_DIR="$(ROOT_DIR)/release"; \
	rm -rf "$$WORK_DIR" && mkdir -p "$$WORK_DIR"; \
	NOTES_FILE="$$WORK_DIR/release-notes.md"; \
	if [ -n "$(NOTES)" ]; then \
	  printf '%s' "$(NOTES)" | tr '+' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$$//; /^$$/d; s/^/- /' > "$$NOTES_FILE"; \
	else \
	  printf 'Bug fixes and improvements\n' > "$$NOTES_FILE"; \
	fi; \
	cleanup() { \
	  if [ -f "$(DESKTOP_DIR)/wails.json.kurlo.bak" ]; then \
	    mv "$(DESKTOP_DIR)/wails.json.kurlo.bak" "$(DESKTOP_DIR)/wails.json"; \
	  fi; \
	}; \
	trap cleanup EXIT INT TERM; \
	printf '\033[1m[1/7]\033[0m Tagging v$(_NEXT) locally\n'; \
	if git rev-parse "v$(_NEXT)" >/dev/null 2>&1; then \
	  printf '       \033[90mtag v$(_NEXT) already exists locally — reusing\033[0m\n'; \
	else \
	  git tag -a "v$(_NEXT)" -F "$$NOTES_FILE"; \
	fi; \
	printf '\033[1m[2/7]\033[0m Updating apps/desktop/wails.json productVersion\n'; \
	cp "$(DESKTOP_DIR)/wails.json" "$(DESKTOP_DIR)/wails.json.kurlo.bak"; \
	node -e "const fs=require('fs');const p='$(DESKTOP_DIR)/wails.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.info=j.info||{};j.info.productVersion='$(_NEXT)';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"; \
	printf '\033[1m[3/7]\033[0m Building macOS universal binary (appVersion=$(_NEXT))\n'; \
	$(MAKE) -s build-macos VERSION="$(_NEXT)"; \
	printf '\033[1m[4/7]\033[0m Packaging raw binary + installer\n'; \
	cp "$(DESKTOP_DIR)/build/bin/Kurlo.app/Contents/MacOS/kurlo" "$$WORK_DIR/kurlo-darwin-universal"; \
	(cd "$(DESKTOP_DIR)/build/bin" && ditto -c -k --keepParent Kurlo.app "$$WORK_DIR/kurlo-darwin-universal.app.zip"); \
	if command -v create-dmg >/dev/null 2>&1; then \
	  "$(DESKTOP_DIR)/build/darwin/make-dmg.sh" \
	    "$(DESKTOP_DIR)/build/bin/Kurlo.app" \
	    "$$WORK_DIR/kurlo-$(_NEXT)-darwin-universal.dmg" \
	    "Kurlo $(_NEXT)"; \
	else \
	  printf '       \033[90mcreate-dmg not installed — packaging .app as .zip instead\033[0m\n'; \
	  (cd "$(DESKTOP_DIR)/build/bin" && ditto -c -k --sequesterRsrc --keepParent Kurlo.app "$$WORK_DIR/kurlo-$(_NEXT)-darwin-universal.zip"); \
	fi; \
	printf '\033[1m[5/7]\033[0m Signing\n'; \
	if [ -f "$(ROOT_DIR)/update-signing-key" ]; then \
	  minisign -S -s "$(ROOT_DIR)/update-signing-key" \
	    -t "kurlo v$(_NEXT) kurlo-darwin-universal" \
	    -m "$$WORK_DIR/kurlo-darwin-universal"; \
	  test -f "$$WORK_DIR/kurlo-darwin-universal.minisig"; \
	  minisign -S -s "$(ROOT_DIR)/update-signing-key" \
	    -t "kurlo v$(_NEXT) kurlo-darwin-universal.app.zip" \
	    -m "$$WORK_DIR/kurlo-darwin-universal.app.zip"; \
	  test -f "$$WORK_DIR/kurlo-darwin-universal.app.zip.minisig"; \
	  printf '       \033[32m✓\033[0m minisign signature created\n'; \
	else \
	  printf '       \033[90mskipped — no update-signing-key in repo root\033[0m\n'; \
	fi; \
	printf '\033[1m[6/7]\033[0m Generating latest.json and SHA256SUMS.txt\n'; \
	python3 "$(ROOT_DIR)/scripts/make-latest-json.py" \
	  --release-dir "$$WORK_DIR" \
	  --tag "v$(_NEXT)" \
	  --repo "$(UPDATE_REPO)" \
	  --notes-file "$$NOTES_FILE" \
	  --platforms darwin-universal,darwin-universal-app; \
	(cd "$$WORK_DIR" && shasum -a 256 * | grep -v 'SHA256SUMS.txt' > SHA256SUMS.txt); \
	printf '\033[1m[7/7]\033[0m Publishing to github.com/$(UPDATE_REPO)\n'; \
	if gh release view "v$(_NEXT)" --repo "$(UPDATE_REPO)" >/dev/null 2>&1; then \
	  printf '       \033[90mrelease exists — uploading with --clobber\033[0m\n'; \
	  gh release upload "v$(_NEXT)" "$$WORK_DIR"/* --repo "$(UPDATE_REPO)" --clobber; \
	  gh release edit "v$(_NEXT)" --repo "$(UPDATE_REPO)" --title "v$(_NEXT)" --notes-file "$$NOTES_FILE" --prerelease --latest=false; \
	else \
	  CHANNEL="--prerelease --latest=false"; \
	  gh release create "v$(_NEXT)" "$$WORK_DIR"/* --repo "$(UPDATE_REPO)" --title "v$(_NEXT)" --notes-file "$$NOTES_FILE" $$CHANNEL; \
	fi; \
	printf '\n\033[32m✓\033[0m Released v$(_NEXT) (macOS-only).\n'; \
	printf '  https://github.com/$(UPDATE_REPO)/releases/tag/v$(_NEXT)\n'; \
	printf '\nThe local source-repo tag was NOT pushed (to avoid triggering CI).\n'; \
	printf 'If you want it on GitHub later: \033[1mgit push origin v$(_NEXT)\033[0m\n'








release-mac-publish:
	@if [ ! -d "$(ROOT_DIR)/release" ]; then \
		printf '\033[31mError:\033[0m no $(ROOT_DIR)/release directory — run "make release-mac-local" first.\n'; \
		exit 1; \
	fi
	@if ! command -v gh >/dev/null 2>&1; then \
		printf '\033[31mError:\033[0m gh CLI is not installed.\n'; \
		exit 1; \
	fi
	@set -e; \
	WORK_DIR="$(ROOT_DIR)/release"; \
	if [ -n "$(v)" ]; then \
	  TAG="v$(v)"; \
	elif [ -f "$$WORK_DIR/latest.json" ]; then \
	  TAG="v$$(python3 -c "import json,sys; print(json.load(open('$$WORK_DIR/latest.json'))['version'])")"; \
	else \
	  printf '\033[31mError:\033[0m cannot determine version. Pass v=X.Y.Z explicitly.\n'; \
	  exit 1; \
	fi; \
	NOTES_FILE="$$WORK_DIR/release-notes.md"; \
	if [ ! -f "$$NOTES_FILE" ]; then printf 'Bug fixes and improvements\n' > "$$NOTES_FILE"; fi; \
	CHANNEL="--prerelease --latest=false"; \
	printf '\033[1m[1/1]\033[0m Publishing %s to github.com/$(UPDATE_REPO)\n' "$$TAG"; \
	for attempt in 1 2 3; do \
	  if gh release view "$$TAG" --repo "$(UPDATE_REPO)" >/dev/null 2>&1; then \
	    printf '       \033[90mrelease exists — uploading with --clobber (try %d)\033[0m\n' "$$attempt"; \
	    if gh release upload "$$TAG" "$$WORK_DIR"/* --repo "$(UPDATE_REPO)" --clobber; then \
	      gh release edit "$$TAG" --repo "$(UPDATE_REPO)" --title "$$TAG" --notes-file "$$NOTES_FILE" $$CHANNEL; \
	      break; \
	    fi; \
	  else \
	    printf '       \033[90mcreating new release (try %d)\033[0m\n' "$$attempt"; \
	    if gh release create "$$TAG" "$$WORK_DIR"/* --repo "$(UPDATE_REPO)" --title "$$TAG" --notes-file "$$NOTES_FILE" $$CHANNEL; then \
	      break; \
	    fi; \
	  fi; \
	  if [ "$$attempt" = "3" ]; then \
	    printf '\033[31mError:\033[0m publish failed after 3 attempts.\n'; \
	    exit 1; \
	  fi; \
	  printf '       \033[90mretrying after 5s...\033[0m\n'; \
	  sleep 5; \
	done; \
	printf '\n\033[32m✓\033[0m Published %s.\n' "$$TAG"; \
	printf '  https://github.com/$(UPDATE_REPO)/releases/tag/%s\n' "$$TAG"

dev:
	cd $(DESKTOP_DIR) && $(DEV_ENV) $(WAILS_CMD) dev $(HOST_WAILS_TAGS)

dev-go:
	cd $(DESKTOP_DIR) && $(DEV_ENV) go run github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION) dev $(HOST_WAILS_TAGS)

dev-run: dev

frontend:
	cd $(ROOT_DIR) && npm run frontend:dev

install:
	cd $(ROOT_DIR) && npm install
	cd $(DESKTOP_DIR) && $(GO_ENV) go mod tidy

tidy:
	cd $(DESKTOP_DIR) && $(GO_ENV) go mod tidy

check:
	cd $(ROOT_DIR) && npm run lint
	cd $(ROOT_DIR) && npm run frontend:check
	cd $(ROOT_DIR) && npm --workspace @kurlo/desktop-frontend run test
	cd $(ROOT_DIR) && $(GO_ENV) go test ./apps/desktop/...

test:
	cd $(ROOT_DIR) && $(GO_ENV) go test ./apps/desktop/...

MCP_SCHEMA_DIR := $(DESKTOP_DIR)/internal/api/testdata/mcp-schema
MCP_SCHEMA_REVISIONS := 2024-11-05 2025-03-26 2025-06-18 2025-11-25 2026-07-28

mcp-schemas:
	@for revision in $(MCP_SCHEMA_REVISIONS); do \
		curl -fsSL -o $(MCP_SCHEMA_DIR)/$$revision.json https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/$$revision/schema.json || exit 1; \
	done
	@curl -fsSL -o $(MCP_SCHEMA_DIR)/LICENSE https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/LICENSE

test-extension:
	cd $(ROOT_DIR) && $(GO_ENV) KURLO_BROWSER_EXTENSION_TEST=1 go test ./apps/desktop/internal/api/ -run TestCookieSyncWithARealBrowserExtension -count=1 -v

build: build-desktop

build-desktop:
	cd $(DESKTOP_DIR) && $(GO_ENV) $(WAILS_CMD) build $(HOST_WAILS_TAGS) -ldflags "$(LDFLAGS)"

build-macos:
	cd $(DESKTOP_DIR) && $(GO_ENV) $(WAILS_CMD) build -platform darwin/universal -ldflags "$(LDFLAGS)"

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
	cd $(DESKTOP_DIR) && $(GO_ENV) $(WAILS_CMD) build -platform linux/amd64 $(LINUX_WAILS_TAGS) -ldflags "$(LDFLAGS)"

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

bindings:
	cd $(DESKTOP_DIR) && $(GO_ENV) go run github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION) generate module
	@printf '\n\033[32m✓\033[0m Bindings regenerated in apps/desktop/frontend/wailsjs.\n'

screenshots:
	cd $(DESKTOP_DIR)/frontend && KURLO_DOCS_SCREENSHOT_DIR=$(CURDIR)/apps/web/src/assets/screenshots npx playwright test e2e/full-app.spec.ts --project=chromium
	@printf '\n\033[32m✓\033[0m Documentation screenshots retaken in apps/web/src/assets/screenshots.\n'

readme-screenshot:
	cd $(DESKTOP_DIR)/frontend && KURLO_README_SCREENSHOT=$(CURDIR)/.github/assets/screenshot.png npx playwright test e2e/full-app.spec.ts --project=chromium -g "README screenshot"
	@printf '\n\033[32m✓\033[0m README screenshot retaken in .github/assets/screenshot.png.\n'
