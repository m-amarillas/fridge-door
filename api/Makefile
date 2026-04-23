.PHONY: run sync lint fmt check

# Start the API server with hot reload
run:
	uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Install / sync dependencies from pyproject.toml
sync:
	uv sync

# Run the linter
lint:
	uv run ruff check .

# Auto-format all Python source files
fmt:
	uv run ruff format .

# Format, lint, and verify in sequence — run this before committing
check: fmt lint
