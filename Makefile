PYTHON ?= python3
HOST ?= 127.0.0.1
PORT ?= 3458
WORKSPACE ?= workspace

.PHONY: test serve help
help:
	@printf '%s\n' 'make test                 Run backend, frontend, legacy and tool tests' 'make serve                Serve the multi-lab workspace on localhost' 'make test PYTHON=.venv/bin/python  Include optional PDF tests' 'Use python -m ece218 --help for import and review commands.'

test:
	$(PYTHON) -m unittest discover -s tests -v
	$(PYTHON) -m unittest discover -s summary -p 'test_*.py' -v
	$(PYTHON) -m unittest discover -s tools -p 'test_*.py' -v
	node --test web/frontend.test.cjs summary/frontend.test.cjs

serve:
	$(PYTHON) -m ece218 --workspace $(WORKSPACE) serve --host $(HOST) --port $(PORT)
