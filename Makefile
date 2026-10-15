# Kubi — desktop Kubernetes client (Tauri 2 + React).
#
#   make dev    run the app in dev mode with hot reload
#   make dmg    build a distributable .dmg
#   make test   run Rust tests and build the frontend

APP_DIR    := apps/desktop
NPM        := npm --prefix $(APP_DIR)
BUNDLE_DMG := target/release/bundle/dmg

.DEFAULT_GOAL := help

.PHONY: help install dev build dmg dmg-styled test clean distclean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install JS dependencies
	$(NPM) install

dev: | $(APP_DIR)/node_modules/.bin/tauri ## Run the desktop app in dev mode (Vite + Tauri hot reload)
	cd $(APP_DIR) && npm run tauri -- dev

build: | $(APP_DIR)/node_modules/.bin/tauri ## Build the macOS .app bundle
	cd $(APP_DIR) && npm run tauri -- build --bundles app

# `app,dmg` together: asking for the dmg alone makes the bundler clean up an
# `.app` it never wrote and fail after a valid dmg was produced.
# `CI=true` makes the bundler pass --skip-jenkins to create-dmg, which skips the
# Finder AppleScript. That step fails on macOS 15+/26 ("Can't set statusbar
# visible of container window", -10006) and needs Finder Automation permission;
# only the icon layout of the dmg window is lost. Use dmg-styled for the pretty one.
dmg: | $(APP_DIR)/node_modules/.bin/tauri ## Build a distributable .dmg (plus the .app)
	cd $(APP_DIR) && CI=true npm run tauri -- build --bundles app,dmg
	@ls -1 $(BUNDLE_DMG)/*.dmg

dmg-styled: | $(APP_DIR)/node_modules/.bin/tauri ## Build a .dmg with the Finder icon layout (needs Finder Automation permission)
	cd $(APP_DIR) && npm run tauri -- build --bundles app,dmg
	@ls -1 $(BUNDLE_DMG)/*.dmg

$(APP_DIR)/node_modules/.bin/tauri:
	$(NPM) install

test: ## Run Rust tests and build the frontend (tsc + vite)
	cargo test --workspace
	$(NPM) run build

clean: ## Remove build artifacts
	cargo clean
	rm -rf $(APP_DIR)/dist

distclean: clean ## Also remove installed JS dependencies
	rm -rf $(APP_DIR)/node_modules
