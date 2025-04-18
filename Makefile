SHELL := bash

.DELETE_ON_ERROR:
.DEFAULT_GOAL := ci

is_ci := $(shell if [ ! -z "$(CODEBUILD_BUILD_ARN)" ] || [ ! -z "$(GITHUB_ACTIONS)" ]; then echo 'true'; else echo 'false'; fi)

very-clean: clean
	rm -rf dist target node_modules/ package-lock.json
.PHONY: very-clean

clean:
	rm -rf dist target/lint target/test target/build
.PHONY: clean

install: | target/install
target/install:
ifeq ($(is_ci), true)
	npm ci
	# npx playwright install chromium
else
	npm install
endif
	source venv/bin/activate && pip install -r requirements.txt
	mkdir -p $(@D) && touch $@
.PHONY: install

lint: | install target/lint
target/lint:
	npm run lint
	npm run depcheck
	source venv/bin/activate && ruff check
	mkdir -p $(@D) && touch $@
.PHONY: lint

build: | install target/build
target/build:
	npm run build
	mkdir -p $(@D) && touch $@
.PHONY: build

# --- ci
ci: | install lint build
.PHONY: ci
