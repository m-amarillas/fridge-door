GO := /usr/local/go/bin/go

.PHONY: build run clean clean-cache tidy fmt vet check deps

# Compile the worker binary and output it to build/worker
build:
	$(GO) build -o build/worker .

# Build the binary and start the server
run: build
	./build/worker

# Remove the build/ directory and all compiled binaries
clean:
	rm -rf build/

# Clear the Go build cache — use when builds behave unexpectedly
clean-cache:
	$(GO) clean -cache

# Remove unused dependencies and add any that are missing from go.mod/go.sum
tidy:
	$(GO) mod tidy

# Download all dependencies listed in go.mod without building (useful after a fresh clone)
deps:
	$(GO) mod download

# Auto-format all Go source files to standard Go style
fmt:
	$(GO) fmt ./...

# Run static analysis to catch common bugs the compiler won't catch
vet:
	$(GO) vet ./...

# Run all tests
test:
	$(GO) test ./...

# Format, vet, and build in sequence — run this before committing
check: fmt vet build
