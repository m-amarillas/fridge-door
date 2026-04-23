.PHONY: up down api worker mobile

# Build worker binary then start all services via overmind (each in its own tmux pane)
up:	
	OVERMIND_NO_PORT=1 overmind start

# Stop all services
down:
	overmind quit 2>/dev/null || true
	@lsof -ti :8000 | xargs kill 2>/dev/null || true
	@lsof -ti :8080 | xargs kill 2>/dev/null || true

# Start the FastAPI ingest/query layer
api:
	$(MAKE) -C api run

# Build and start the Go OCR worker
worker:
	$(MAKE) -C worker run

# Start the Expo mobile app
mobile:
	cd mobile && npm start
