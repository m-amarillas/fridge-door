worker: cd worker && /usr/local/go/bin/go build -o build/worker . && ./build/worker
api: cd api && uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload
mobile: cd mobile && npm start
