.PHONY: help up down seed e2e lint test contracts codegen bench

help:
	@echo "Open Emarsys — make targets:"
	@echo "  up       — start infrastructure (docker compose up -d)"
	@echo "  down     — stop infrastructure (docker compose down)"
	@echo "  seed     — seed databases and demo data"
	@echo "  e2e      — run end-to-end tests"
	@echo "  lint     — lint all code (turbo + golangci + ruff)"
	@echo "  test     — run all tests"
	@echo "  contracts — validate event schemas and OpenAPI"
	@echo "  codegen  — generate TypeScript/Go from contracts"
	@echo "  bench    — run benchmarks"

up:
	@if [ ! -f deploy/compose/docker-compose.yml ]; then \
		echo "Error: deploy/compose/docker-compose.yml not found"; \
		exit 1; \
	fi
	docker compose -f deploy/compose/docker-compose.yml up -d

down:
	@if [ ! -f deploy/compose/docker-compose.yml ]; then \
		echo "Error: deploy/compose/docker-compose.yml not found"; \
		exit 1; \
	fi
	docker compose -f deploy/compose/docker-compose.yml down

seed:
	@if [ ! -f scripts/seed/run.sh ]; then \
		echo "Error: scripts/seed/run.sh not found (F0.8.T3)"; \
		exit 1; \
	fi
	bash scripts/seed/run.sh

e2e:
	@if [ ! -f tests/e2e/run.sh ]; then \
		echo "Error: tests/e2e/run.sh not found (F0.8.T4)"; \
		exit 1; \
	fi
	bash tests/e2e/run.sh

lint:
	pnpm turbo run lint
	@if [ -f go.work ]; then golangci-lint run ./...; fi
	@if [ -f pyproject.toml ]; then ruff check .; fi

test:
	pnpm turbo run test

contracts:
	@if [ ! -f scripts/codegen/validate-contracts.mjs ]; then \
		echo "Error: scripts/codegen/validate-contracts.mjs not found (F0.3.T1)"; \
		exit 1; \
	fi
	node scripts/codegen/validate-contracts.mjs

codegen:
	@if [ ! -f scripts/codegen/gen.mjs ]; then \
		echo "Error: scripts/codegen/gen.mjs not found (F0.3.T3)"; \
		exit 1; \
	fi
	node scripts/codegen/gen.mjs

bench:
	@if [ ! -f scripts/bench/run.sh ]; then \
		echo "Error: scripts/bench/run.sh not found"; \
		exit 1; \
	fi
	bash scripts/bench/run.sh
