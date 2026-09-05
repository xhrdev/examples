SHELL := bash

.DELETE_ON_ERROR:
.DEFAULT_GOAL := ci

is_ci := $(shell if [ ! -z "$(CODEBUILD_BUILD_ARN)" ] || [ ! -z "$(GITHUB_ACTIONS)" ]; then echo 'true'; else echo 'false'; fi)

# The smoke suite drives real sites through a solver and needs `host=` and
# `api_key=` in .env. Set this where those are not available and only the unit
# tests run.
#
# The case that made it necessary: GitHub withholds repository secrets from
# workflow runs triggered by Dependabot, so .env comes out empty and every
# script in the suite dies on `set host= in .env` — twelve failures that say
# nothing about the bump being tested. Secrets for those runs live in a
# separate Dependabot store; putting the solver host and api key there would
# also work and is a worse trade, since a dependency bump does not need a live
# third-party solve to be worth merging.
skip_live_checks ?=

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

test: | build target/test
target/test:
ifeq ($(is_ci), true)
	@if ls test/*.test.ts >/dev/null 2>&1; then \
		node --test --experimental-test-coverage --test-reporter=spec --test-reporter=lcov --test-reporter-destination=stdout --test-reporter-destination=target/lcov.info test/*.test.ts; \
	fi
ifeq ($(skip_live_checks),)
	npm run lightpanda:download
	npm test
else
	@echo 'skip_live_checks is set: running the unit tests only, not the smoke suite'
	npm run test:unit
endif
else
	npm test
endif
	mkdir -p $(@D) && touch $@
.PHONY: test

# --- ci
ci: | install lint build
.PHONY: ci
