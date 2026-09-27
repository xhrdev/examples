SHELL := bash

.DELETE_ON_ERROR:
.DEFAULT_GOAL := ci

is_ci := $(shell if [ ! -z "$(CODEBUILD_BUILD_ARN)" ] || [ ! -z "$(GITHUB_ACTIONS)" ]; then echo 'true'; else echo 'false'; fi)

very-clean: clean
	rm -rf dist target node_modules/ package-lock.json
.PHONY: very-clean

clean:
	rm -rf dist target/lint target/build
.PHONY: clean

install: | target/install
target/install:
ifeq ($(is_ci), true)
	npm ci --ignore-scripts
else
	npm install
endif
	test -d venv || python3 -m venv venv
	source venv/bin/activate && pip install -q -r requirements.txt
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

# CI runs only the unit tests here — the live smoke suite is a separate
# GitHub Actions job (smoke.yml) with its own .env, so it shows its own
# pass/fail instead of being folded into this target. Locally, `make test`
# still runs both (`npm test` = test:unit && test:smoke) for convenience.
test: | build target/test
target/test:
ifeq ($(is_ci), true)
	@if ls test/*.test.ts >/dev/null 2>&1; then \
		node --test --experimental-test-coverage --test-reporter=spec --test-reporter=lcov --test-reporter-destination=stdout --test-reporter-destination=target/lcov.info test/*.test.ts; \
	fi
	npm run test:unit
else
	npm test
endif
	mkdir -p $(@D) && touch $@
.PHONY: test

# --- ci
ci: | install lint build
.PHONY: ci
