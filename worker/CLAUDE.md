# Worker

Go processing worker. Consumes Asynq jobs from Redis, runs the full document pipeline, writes results to Supabase.

## Pipeline (in order)
1. Dequeue job from Redis via Asynq
2. Fetch image from Supabase Storage using `image_url`
3. OCR — POST image to Mistral OCR API, get back markdown text
4. Classify — POST OCR text to Claude Haiku API, get back `document_type`
5. Chunk — split OCR markdown into overlapping chunks
6. Embed — POST each chunk to Nomic Embed v1.5 (self-hosted, 768-dim)
7. Write — insert rows into `document_chunks`, update `documents.status` to `indexed`
8. **Analyze actions** — POST OCR text to Claude Sonnet (tool calling); store suggested actions in `document_actions`; update `documents.actions_status`

## Action analysis rules (step 8)
- Implemented in `internal/actions/claude.go`
- Uses Claude Sonnet (`claude-sonnet-4-6`) with four tool definitions: `calendar_event`, `task`, `reminder`, `note`
- Runs **after** `SetIndexed` — the document is searchable regardless of whether action analysis succeeds
- **Errors in step 8 MUST NOT return an error from the Asynq handler** — they set `actions_status = failed` and log, nothing more
- Stub mode: if `ANTHROPIC_API_KEY` is unset, `actions.Analyze` returns `nil, nil` and the worker sets `actions_status = ready` with zero rows
- Required env var: `ANTHROPIC_API_KEY`

## Job contract
Consumed from Redis. Defined in `infra/contracts/jobs.md` — do not change without updating FastAPI too.
```json
{ "document_id": "uuid", "user_id": "uuid", "image_url": "string", "image_hash": "string (SHA-256)", "attempt": 1 }
```

## Status transitions owned by this worker
- `queued → processing` on dequeue
- `processing → indexed` on success (step 7)
- `processing → failed` after 3 attempts (job moves to Asynq DLQ)
- `actions_status: null → analyzing → ready` on action analysis success (step 8)
- `actions_status: analyzing → failed` if action analysis errors (step 8, never affects job retry)

## DB rules
- Use `pgx/v5` for all database access — no ORM
- Always include `user_id` on inserts into `document_chunks` and `document_actions`
- Increment `documents.attempt` on each retry before processing

## Vector search rules
- Embeddings are stored in `document_chunks`, not `documents`
- HNSW index uses `vector_cosine_ops` — queries must use `<=>` (cosine distance)
- Using `<->` or `<#>` bypasses the index entirely

## Key decisions
- Go (not Python) — goroutines handle concurrent OCR/embed I/O better than threadpools
- Mistral OCR API over local models — keeps worker pure Go, handles handwriting
- Claude Sonnet for action analysis (not Haiku) — better reasoning on implicit/multi-step actions; re-evaluate if cost becomes a factor
- Single binary deployment
