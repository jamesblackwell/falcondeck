SHELL := /bin/sh

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DESKTOP_DIR := $(ROOT)/apps/desktop
NPM := npm --prefix $(DESKTOP_DIR)
CARGO := cargo
DAEMON_PORT ?= 4123
CODEX_BIN ?= codex

.DEFAULT_GOAL := help

.PHONY: help install dev desktop-dev frontend-dev daemon relay test test-rust test-desktop lint typecheck check fmt build clean

help:
	@printf '%s\n' \
		'FalconDeck dev commands' \
		'' \
		'  make dev            Start relay plus the desktop app (desktop embeds the daemon)' \
		'  make desktop-dev    Start the Tauri desktop app' \
		'  make frontend-dev   Start the Vite frontend only' \
		'  make daemon         Start the standalone daemon on 127.0.0.1:$(DAEMON_PORT)' \
		'  make relay          Start the relay on 127.0.0.1:8787' \
		'  make install        Install desktop app npm dependencies from package-lock.json' \
		'  make test           Run Rust and desktop tests' \
		'  make lint           Run desktop lint checks' \
		'  make typecheck      Run desktop TypeScript checks' \
		'  make check          Run the main validation suite' \
		'  make fmt            Format Rust code' \
		'  make build          Build desktop app and Rust workspace' \
		'  make clean          Remove Rust and desktop build outputs' \
		'' \
		'Overrides:' \
		'  make daemon DAEMON_PORT=5001 CODEX_BIN=/opt/homebrew/bin/codex'

install:
	$(NPM) ci

dev:
	@set -e; \
		$(CARGO) run -p falcondeck-relay & \
		relay_pid=$$!; \
		trap 'kill $$relay_pid 2>/dev/null || true' EXIT INT TERM; \
		sleep 2; \
		if ! kill -0 $$relay_pid 2>/dev/null; then \
			wait $$relay_pid; \
		fi; \
		$(NPM) run tauri:dev

desktop-dev:
	$(NPM) run tauri:dev

frontend-dev:
	$(NPM) run dev

daemon:
	$(CARGO) run -p falcondeck-daemon -- --port=$(DAEMON_PORT) --codex-bin=$(CODEX_BIN)

relay:
	$(CARGO) run -p falcondeck-relay

test: test-rust test-desktop

test-rust:
	$(CARGO) test

test-desktop:
	$(NPM) test

lint:
	$(NPM) run lint

typecheck:
	$(NPM) run typecheck

check: typecheck lint test
	$(CARGO) check

fmt:
	$(CARGO) fmt --all

build:
	$(NPM) run build
	$(CARGO) build --workspace

clean:
	$(CARGO) clean
	rm -rf $(DESKTOP_DIR)/dist
