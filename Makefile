PYTHON ?= .venv/bin/python
NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 3457
DATA_DIR ?= workspace/catalog

.PHONY: help test test-backend test-frontend check build serve
help:
	@printf '%s\n' \
	  'make test                 Run API/domain/security and frontend tests' \
	  'make check                Run tests and TypeScript checks' \
	  'make build                Build the unified frontend' \
	  'make serve                Serve the authenticated catalog on localhost' \
	  'make serve HOST=192.168.1.5 PORT=3457  Serve on a trusted LAN interface' \
	  'make serve DATA_DIR=workspace/another-catalog  Use a separate catalog' \
	  'See README.md for installation and operator access.'

test: test-backend test-frontend

test-backend:
	PYTHONPATH=backend $(PYTHON) -m pytest backend/tests -q

test-frontend:
	$(NPM) --prefix frontend test

check: test
	$(NPM) --prefix frontend run typecheck

build:
	$(NPM) --prefix frontend run build

serve:
	PYTHONPATH=backend $(PYTHON) -m lab_catalog serve --data-dir $(DATA_DIR) --host $(HOST) --port $(PORT) --allowed-host $(HOST):$(PORT) --frontend-dir frontend/dist
