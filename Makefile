SHELL := /bin/sh

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

# Prefer the native Homebrew toolchain on Apple Silicon so npm uses arm64 bindings.
ifeq ($(UNAME_S),Darwin)
ifeq ($(UNAME_M),arm64)
ifneq ($(wildcard /opt/homebrew/bin/node),)
export PATH := /opt/homebrew/bin:$(PATH)
endif
endif
endif

DESKTOP_TAURI_TARGET :=
ifeq ($(UNAME_S),Darwin)
ifeq ($(UNAME_M),arm64)
DESKTOP_TAURI_TARGET := aarch64-apple-darwin
endif
endif

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DESKTOP_DIR := $(ROOT)/apps/desktop
MOBILE_DIR := $(ROOT)/apps/mobile
REMOTE_WEB_DIR := $(ROOT)/apps/remote-web
SITE_DIR := $(ROOT)/apps/site
NPM := npm --workspace apps/desktop
REMOTE_NPM := npm --workspace apps/remote-web
SITE_NPM := npm --workspace apps/site
ROOT_NPM := npm
CARGO := cargo
DAEMON_PORT ?= 4123
RELAY_PORT ?= 8787
UI_PORT ?= 1420
REMOTE_WEB_PORT ?= 4174
RELAY_BIND_HOST ?= 0.0.0.0
CODEX_BIN ?= codex
TAURI_EXPECTED_PACKAGE = @tauri-apps/cli-$$(cd "$(DESKTOP_DIR)" && npm exec -- node -p "process.platform + '-' + process.arch")
DESKTOP_NATIVE_CHECK = cd "$(DESKTOP_DIR)" && npm exec -- node -e "require('@tauri-apps/cli')" && npm exec -- node -e "import('rolldown').then(() => undefined, (error) => { console.error(error); process.exit(1) })"
# The dev overlay keeps watcher-triggered relaunches from stealing focus and
# labels the window "(dev)" so it is distinguishable from the installed app.
TAURI_DEV = cd "$(DESKTOP_DIR)" && npm exec tauri -- dev --config src-tauri/tauri.dev.conf.json
# Kill anything already listening on the UI port (e.g. a stray Vite left
# behind by an agent or background session) so dev targets always start
# cleanly instead of failing with "Port 1420 is already in use".
FREE_UI_PORT = pids=$$(lsof -ti tcp:$(UI_PORT) -sTCP:LISTEN 2>/dev/null || true); \
	if [ -n "$$pids" ]; then \
		echo "Freeing UI port $(UI_PORT) (killing pid(s): $$pids)"; \
		kill $$pids 2>/dev/null || true; \
		sleep 1; \
		leftover=$$(lsof -ti tcp:$(UI_PORT) -sTCP:LISTEN 2>/dev/null || true); \
		if [ -n "$$leftover" ]; then kill -9 $$leftover 2>/dev/null || true; sleep 1; fi; \
	fi
ifeq ($(strip $(DESKTOP_TAURI_TARGET)),)
TAURI_BUILD = cd "$(DESKTOP_DIR)" && npm exec tauri -- build
TAURI_BUILD_INSTALL = cd "$(DESKTOP_DIR)" && npm exec tauri -- build --bundles app --config src-tauri/tauri.local.conf.json
DESKTOP_BUNDLE_APP := $(ROOT)/target/release/bundle/macos/FalconDeck.app
else
TAURI_BUILD = cd "$(DESKTOP_DIR)" && npm exec tauri -- build --target $(DESKTOP_TAURI_TARGET)
TAURI_BUILD_INSTALL = cd "$(DESKTOP_DIR)" && npm exec tauri -- build --target $(DESKTOP_TAURI_TARGET) --bundles app --config src-tauri/tauri.local.conf.json
DESKTOP_BUNDLE_APP := $(ROOT)/target/$(DESKTOP_TAURI_TARGET)/release/bundle/macos/FalconDeck.app
endif
APPLICATIONS_APP := /Applications/FalconDeck.app
MOBILE_METRO_PORT ?= 8081
IOS_SIMULATOR ?= iPhone 16 Pro
MOBILE_METRO_PID_FILE = /tmp/falcondeck-mobile-metro-$(MOBILE_METRO_PORT).pid
MOBILE_METRO_LOG_FILE = /tmp/falcondeck-mobile-metro.log

.DEFAULT_GOAL := help

.PHONY: help install desktop-prepare desktop-brand-assets mobile-prepare remote-web-prepare site-prepare dev mobile-dev mobile-dev-stop dev-mobile mobile-build mobile-deploy mobile-test desktop-dev desktop-dev-stop desktop-install frontend-dev remote-web-dev site-dev daemon relay test test-rust test-desktop test-mobile lint typecheck check fmt build clean

help:
	@printf '%s\n' \
		'FalconDeck dev commands' \
		'' \
		'Run things:' \
		'  make dev              Start relay, remote web, and the desktop app' \
		'  make desktop-dev      Start the Tauri desktop app (frees a stuck UI port first)' \
		'  make desktop-dev-stop Stop the reusable desktop dev daemon' \
		'  make mobile-dev       Open Simulator and run the FalconDeck iOS app locally' \
		'  make mobile-dev-stop  Stop the background Expo dev server used by mobile-dev' \
		'  make dev-mobile       Alias for make mobile-dev' \
		'  make frontend-dev     Start the Vite frontend only' \
		'  make remote-web-dev   Start the remote web client on the local network' \
		'  make site-dev         Start the marketing site locally' \
		'  make daemon           Start the standalone daemon on 127.0.0.1:$(DAEMON_PORT)' \
		'  make relay            Start the relay on $(RELAY_BIND_HOST):$(RELAY_PORT)' \
		'' \
		'Build & install:' \
		'  make install          Install desktop, mobile, and web dependencies' \
		'  make desktop-install  Build the packaged desktop app and install it to /Applications' \
		'  make desktop-brand-assets Regenerate desktop icons/brand assets' \
		'  make build            Build desktop, remote web, and site bundles' \
		'  make mobile-build     Build the iOS app via EAS (cloud, ad-hoc distribution)' \
		'  make mobile-deploy    Push an OTA JS update to the preview channel' \
		'  make clean            Remove Rust and desktop build outputs' \
		'' \
		'Validate:' \
		'  make check            Typecheck + lint + all tests + cargo check' \
		'  make test             Run Rust and desktop tests' \
		'  make test-rust        Run the Rust workspace tests only' \
		'  make test-desktop     Run the desktop (vitest) tests only' \
		'  make test-mobile      Run mobile unit tests (alias: make mobile-test)' \
		'  make lint             Run desktop lint checks' \
		'  make typecheck        Run desktop TypeScript checks' \
		'  make fmt              Format Rust code' \
		'' \
		'Deploy:' \
		'  ./deploy.sh           Deploy the relay to production via Ansible' \
		'' \
		'Overrides:' \
		'  make daemon DAEMON_PORT=5001 CODEX_BIN=/opt/homebrew/bin/codex' \
		'  make dev RELAY_PORT=8788 UI_PORT=1421 REMOTE_WEB_PORT=4175' \
		'  make mobile-dev IOS_SIMULATOR="iPhone 16 Pro" MOBILE_METRO_PORT=8081'

install:
	@$(MAKE) desktop-prepare
	@$(MAKE) mobile-prepare
	@$(MAKE) remote-web-prepare
	@$(MAKE) site-prepare

desktop-prepare:
	@set -e; \
		expected_package="$(TAURI_EXPECTED_PACKAGE)"; \
		echo "Checking desktop dependencies ($$expected_package)"; \
		if [ ! -d "$(DESKTOP_DIR)/node_modules/@tauri-apps/cli" ] || [ ! -d "$(DESKTOP_DIR)/node_modules/$$expected_package" ]; then \
			echo "Repairing workspace dependencies for the current platform"; \
			rm -rf "$(ROOT)/node_modules" "$(DESKTOP_DIR)/node_modules" "$(REMOTE_WEB_DIR)/node_modules" "$(SITE_DIR)/node_modules"; \
			$(ROOT_NPM) install; \
		fi; \
		if ! ($(DESKTOP_NATIVE_CHECK)); then \
			echo "Retrying workspace install after desktop native dependency check failed"; \
			rm -rf "$(ROOT)/node_modules" "$(DESKTOP_DIR)/node_modules" "$(REMOTE_WEB_DIR)/node_modules" "$(SITE_DIR)/node_modules"; \
			$(ROOT_NPM) install; \
			($(DESKTOP_NATIVE_CHECK)); \
		fi

desktop-brand-assets: desktop-prepare
	@set -e; \
		echo "Refreshing desktop brand assets"; \
		cd "$(ROOT)" && node ./scripts/generate-brand-assets.mjs --desktop-only

mobile-prepare:
	@set -e; \
		if [ ! -d "$(ROOT)/node_modules" ] || [ ! -d "$(MOBILE_DIR)/node_modules" ]; then \
			echo "Installing workspace dependencies"; \
			$(ROOT_NPM) install; \
		fi

remote-web-prepare:
	@set -e; \
		if [ ! -d "$(ROOT)/node_modules" ]; then \
			echo "Installing workspace dependencies"; \
			$(ROOT_NPM) install; \
		fi

site-prepare:
	@set -e; \
		if [ ! -d "$(ROOT)/node_modules" ]; then \
			echo "Installing workspace dependencies"; \
			$(ROOT_NPM) install; \
		fi

dev: desktop-prepare remote-web-prepare
	@set -e; \
		$(NPM) run tauri:dev:stop >/dev/null 2>&1 || true; \
		$(FREE_UI_PORT); \
		if lsof -ti tcp:$(REMOTE_WEB_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
			echo "Using existing remote web client on port $(REMOTE_WEB_PORT)"; \
			remote_web_pid=""; \
		else \
			$(REMOTE_NPM) run dev -- --host 0.0.0.0 --port $(REMOTE_WEB_PORT) & \
			remote_web_pid=$$!; \
		fi; \
		relay_pid=""; \
		if lsof -ti tcp:$(RELAY_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
			echo "Using existing relay on port $(RELAY_PORT)"; \
		else \
			FALCONDECK_RELAY_BIND=$(RELAY_BIND_HOST):$(RELAY_PORT) $(CARGO) run -p falcondeck-relay & \
			relay_pid=$$!; \
			sleep 2; \
			if ! kill -0 $$relay_pid 2>/dev/null; then \
				wait $$relay_pid; \
			fi; \
		fi; \
		trap 'if [ -n "$$remote_web_pid" ]; then kill $$remote_web_pid 2>/dev/null || true; fi; if [ -n "$$relay_pid" ]; then kill $$relay_pid 2>/dev/null || true; fi; $(NPM) run tauri:dev:stop >/dev/null 2>&1 || true' EXIT INT TERM; \
		$(TAURI_DEV)

mobile-dev: mobile-prepare
	@set -e; \
		if ! command -v xcrun >/dev/null 2>&1; then \
			echo "xcrun is required for iOS simulator development. Install Xcode and its command line tools."; \
			exit 1; \
		fi; \
		if ! command -v open >/dev/null 2>&1; then \
			echo "The Simulator launcher is only supported on macOS."; \
			exit 1; \
		fi; \
		echo "Opening iOS Simulator"; \
		open -a Simulator; \
		sleep 2; \
		booted_udid=""; \
		current_udid=$$(defaults read com.apple.iphonesimulator CurrentDeviceUDID 2>/dev/null || true); \
		if [ -n "$$current_udid" ] && xcrun simctl list devices booted | grep -q "$$current_udid"; then \
			booted_udid="$$current_udid"; \
		else \
			booted_udid=$$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-]*\)) (Booted).*/\1/p' | head -n 1); \
		fi; \
		if [ -z "$$booted_udid" ]; then \
			simulator_udid=$$(xcrun simctl list devices available | sed -n 's/^[[:space:]]*$(IOS_SIMULATOR) (\([0-9A-F-]*\)) (.*/\1/p' | head -n 1); \
			if [ -z "$$simulator_udid" ]; then \
				echo "Could not find an available simulator named $(IOS_SIMULATOR)."; \
				exit 1; \
			fi; \
			echo "Booting simulator: $(IOS_SIMULATOR)"; \
			xcrun simctl boot "$$simulator_udid" >/dev/null 2>&1 || true; \
			xcrun simctl bootstatus "$$simulator_udid" -b; \
			booted_udid="$$simulator_udid"; \
		fi; \
		if [ -z "$$booted_udid" ]; then \
			echo "No booted simulator found. Open Simulator, boot a device, then rerun make mobile-dev."; \
			exit 1; \
		fi; \
		echo "Using simulator $$booted_udid"; \
		xcrun simctl bootstatus $$booted_udid -b; \
		if lsof -ti tcp:$(MOBILE_METRO_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
			existing_metro_pid=$$(lsof -ti tcp:$(MOBILE_METRO_PORT) -sTCP:LISTEN | head -n 1); \
			existing_metro_cmd=$$(ps -p $$existing_metro_pid -o command=); \
			existing_metro_cwd=$$(lsof -a -p $$existing_metro_pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1); \
			case "$$existing_metro_cmd|$$existing_metro_cwd" in \
				*"$(MOBILE_DIR)"*|*"falcondeck/apps/mobile"*) \
					echo "Using existing Expo dev server on port $(MOBILE_METRO_PORT)"; \
					;; \
				*) \
					echo "Port $(MOBILE_METRO_PORT) is in use by a different process:"; \
					echo "$$existing_metro_cmd"; \
					echo "Stop that server or rerun with a different MOBILE_METRO_PORT."; \
					exit 1; \
					;; \
			esac; \
		else \
			if [ -f "$(MOBILE_METRO_PID_FILE)" ]; then \
				stale_pid=$$(cat "$(MOBILE_METRO_PID_FILE)" 2>/dev/null || true); \
				if [ -n "$$stale_pid" ] && ! kill -0 "$$stale_pid" 2>/dev/null; then \
					rm -f "$(MOBILE_METRO_PID_FILE)"; \
				fi; \
			fi; \
			echo "Starting Expo dev server on port $(MOBILE_METRO_PORT)"; \
			cd "$(MOBILE_DIR)" && nohup npx expo start --dev-client --port $(MOBILE_METRO_PORT) >"$(MOBILE_METRO_LOG_FILE)" 2>&1 < /dev/null & \
			metro_pid=$$!; \
			echo "$$metro_pid" > "$(MOBILE_METRO_PID_FILE)"; \
			sleep 5; \
			if ! kill -0 "$$metro_pid" 2>/dev/null; then \
				echo "Expo dev server failed to start. Check $(MOBILE_METRO_LOG_FILE)"; \
				exit 1; \
			fi; \
			echo "Expo dev server running in background (pid $$metro_pid)"; \
		fi; \
		echo "Building FalconDeck for simulator $$booted_udid"; \
		extra_build_settings=""; \
		if [ "$(MOBILE_METRO_PORT)" != "8081" ]; then extra_build_settings="GCC_PREPROCESSOR_DEFINITIONS=\$$(inherited) RCT_METRO_PORT=$(MOBILE_METRO_PORT)"; fi; \
		cd "$(MOBILE_DIR)/ios" && xcodebuild -workspace FalconDeck.xcworkspace -scheme FalconDeck -configuration Debug -destination "id=$$booted_udid" -derivedDataPath DerivedData $$extra_build_settings build; \
		xcrun simctl terminate $$booted_udid com.falcondeck.mobile >/dev/null 2>&1 || true; \
		xcrun simctl install $$booted_udid "$(MOBILE_DIR)/ios/DerivedData/Build/Products/Debug-iphonesimulator/FalconDeck.app"; \
		xcrun simctl launch $$booted_udid com.falcondeck.mobile; \
		echo "FalconDeck launched. Metro log: $(MOBILE_METRO_LOG_FILE)"

mobile-dev-stop:
	@set -e; \
		if [ -f "$(MOBILE_METRO_PID_FILE)" ]; then \
			metro_pid=$$(cat "$(MOBILE_METRO_PID_FILE)" 2>/dev/null || true); \
			if [ -n "$$metro_pid" ] && kill -0 "$$metro_pid" 2>/dev/null; then \
				echo "Stopping Expo dev server $$metro_pid"; \
				kill "$$metro_pid" 2>/dev/null || true; \
			fi; \
			rm -f "$(MOBILE_METRO_PID_FILE)"; \
		else \
			echo "No FalconDeck Expo dev server pid file found for port $(MOBILE_METRO_PORT)"; \
		fi

dev-mobile: mobile-dev

mobile-build: mobile-prepare
	@echo "Building iOS preview via EAS (ad-hoc, installable via link)"
	cd "$(MOBILE_DIR)" && eas build --profile preview --platform ios

mobile-deploy: mobile-prepare
	@echo "Pushing OTA update to preview-testflight channel"
	cd "$(MOBILE_DIR)" && eas update --branch preview-testflight --message "$(or $(MSG),mobile update)"

mobile-test: mobile-prepare
	cd "$(MOBILE_DIR)" && npx vitest run

test-mobile: mobile-test

desktop-dev: desktop-prepare
	@$(NPM) run tauri:dev:stop >/dev/null 2>&1 || true
	@$(FREE_UI_PORT)
	@$(TAURI_DEV)

desktop-dev-stop: desktop-prepare
	@$(NPM) run tauri:dev:stop

desktop-install: desktop-brand-assets
	@set -e; \
		if [ -n "$(DESKTOP_TAURI_TARGET)" ]; then \
			if command -v rustup >/dev/null 2>&1; then \
				if ! rustup target list --installed | grep -qx "$(DESKTOP_TAURI_TARGET)"; then \
					echo "Installing Rust target $(DESKTOP_TAURI_TARGET)"; \
					rustup target add "$(DESKTOP_TAURI_TARGET)"; \
				fi; \
			else \
				echo "rustup is required to build the native desktop target $(DESKTOP_TAURI_TARGET)"; \
				exit 1; \
			fi; \
		fi; \
		echo "Building packaged FalconDeck desktop app"; \
		rm -rf "$(DESKTOP_BUNDLE_APP)"; \
		$(TAURI_BUILD_INSTALL); \
		if [ ! -d "$(DESKTOP_BUNDLE_APP)" ]; then \
			echo "Expected app bundle not found at $(DESKTOP_BUNDLE_APP)"; \
			exit 1; \
		fi; \
		echo "Installing FalconDeck.app to $(APPLICATIONS_APP)"; \
		rm -rf "$(APPLICATIONS_APP)"; \
		ditto "$(DESKTOP_BUNDLE_APP)" "$(APPLICATIONS_APP)"; \
		if command -v codesign >/dev/null 2>&1; then \
			echo "Ad-hoc signing FalconDeck.app for stable local macOS identity"; \
			codesign --force --deep --sign - "$(APPLICATIONS_APP)"; \
		fi; \
		echo "Installed $(APPLICATIONS_APP)"

frontend-dev: desktop-prepare
	$(NPM) run dev

remote-web-dev: remote-web-prepare
	$(REMOTE_NPM) run dev -- --host 0.0.0.0 --port $(REMOTE_WEB_PORT)

site-dev: site-prepare
	$(SITE_NPM) run dev

daemon:
	$(CARGO) run -p falcondeck-daemon -- --port=$(DAEMON_PORT) --codex-bin=$(CODEX_BIN)

relay:
	FALCONDECK_RELAY_BIND=$(RELAY_BIND_HOST):$(RELAY_PORT) $(CARGO) run -p falcondeck-relay

test: test-rust test-desktop

test-rust:
	$(CARGO) test

test-desktop: desktop-prepare
	$(NPM) test

lint: desktop-prepare
	$(NPM) run lint

typecheck: desktop-prepare
	$(NPM) run typecheck

check: typecheck lint test
	$(CARGO) check

fmt:
	$(CARGO) fmt --all

build: desktop-prepare
	$(NPM) run build
	$(REMOTE_NPM) run build
	$(SITE_NPM) run build
	$(CARGO) build --workspace

clean:
	$(CARGO) clean
	rm -rf $(DESKTOP_DIR)/dist $(REMOTE_WEB_DIR)/dist $(SITE_DIR)/dist
