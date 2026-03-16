SHELL := /bin/sh

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DESKTOP_DIR := $(ROOT)/apps/desktop
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
TAURI_DEV = cd "$(DESKTOP_DIR)" && npm exec tauri -- dev

.DEFAULT_GOAL := help

.PHONY: help install desktop-prepare remote-web-prepare site-prepare dev desktop-dev frontend-dev remote-web-dev site-dev daemon relay test test-rust test-desktop lint typecheck check fmt build clean

help:
	@printf '%s\n' \
		'FalconDeck dev commands' \
		'' \
		'  make dev            Start relay, remote web, and the desktop app' \
		'  make desktop-dev    Start the Tauri desktop app' \
		'  make frontend-dev   Start the Vite frontend only' \
		'  make remote-web-dev Start the remote web client on the local network' \
		'  make site-dev       Start the marketing site locally' \
		'  make daemon         Start the standalone daemon on 127.0.0.1:$(DAEMON_PORT)' \
		'  make relay          Start the relay on $(RELAY_BIND_HOST):$(RELAY_PORT)' \
		'  make install        Install desktop and remote web dependencies' \
		'  make test           Run Rust and desktop tests' \
		'  make lint           Run desktop lint checks' \
		'  make typecheck      Run desktop TypeScript checks' \
		'  make check          Run the main validation suite' \
		'  make fmt            Format Rust code' \
		'  make build          Build desktop app and Rust workspace' \
		'  make clean          Remove Rust and desktop build outputs' \
		'' \
		'Overrides:' \
		'  make daemon DAEMON_PORT=5001 CODEX_BIN=/opt/homebrew/bin/codex' \
		'  make dev RELAY_PORT=8788 UI_PORT=1421 REMOTE_WEB_PORT=4175'

install:
	@$(MAKE) desktop-prepare
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
		if ! (cd "$(DESKTOP_DIR)" && npm exec -- node -e "require('@tauri-apps/cli')"); then \
			echo "Retrying workspace install after native binding check failed"; \
			rm -rf "$(ROOT)/node_modules" "$(DESKTOP_DIR)/node_modules" "$(REMOTE_WEB_DIR)/node_modules" "$(SITE_DIR)/node_modules"; \
			$(ROOT_NPM) install; \
			(cd "$(DESKTOP_DIR)" && npm exec -- node -e "require('@tauri-apps/cli')"); \
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
		if lsof -ti tcp:$(UI_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
			echo "Port $(UI_PORT) is already in use. Stop the existing FalconDeck frontend or choose another UI_PORT."; \
			exit 1; \
		fi; \
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
		trap 'if [ -n "$$remote_web_pid" ]; then kill $$remote_web_pid 2>/dev/null || true; fi; if [ -n "$$relay_pid" ]; then kill $$relay_pid 2>/dev/null || true; fi' EXIT INT TERM; \
		$(TAURI_DEV)

desktop-dev: desktop-prepare
	@$(TAURI_DEV)

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
