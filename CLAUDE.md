# The Fridge Door

Mobile app that lets parents capture physical school documents (camera), OCR them, embed and store in a vector DB, then search with natural language. Full architecture: `docs/architecture.md`.

## What this is NOT
- Not a generic document scanner — focused on school papers, family use
- No manual tagging — auto-classification via LLM at ingest
- No complex UX (yet) — functionality first

## Monorepo structure
```
mobile/    Expo + React Native (TypeScript)
api/       FastAPI — thin ingest + query layer only (Python)
worker/    Go processing worker (Asynq)
infra/     docker-compose, Supabase migrations, job contract
docs/      architecture.md (full decision log)
```

## Tech stack (decided — do not re-suggest alternatives)
| Layer | Choice |
|---|---|
| Mobile | Expo SDK 54, React Native, expo-router, expo-camera |
| Ingest API | FastAPI (Python) — validate JWT, store image, enqueue job, return 202 |
| Queue | Redis + Asynq |
| Worker | **Go** + Asynq — goroutines, pgx, single binary |
| OCR | Mistral OCR API (HTTP from Go worker) |
| Auto-classify | Claude Haiku API |
| **Action analysis** | **Claude Sonnet (tool calling, Go worker) — extracts structured actions from OCR text** |
| Embeddings | Nomic Embed v1.5 (self-hosted, 768-dim) |
| RAG | LlamaIndex (Python, query path only) |
| LLM search | Claude Sonnet (tool calling) |
| Vector DB | PostgreSQL + pgvector via Supabase (Qdrant when >5-10M vectors) |
| Auth/Infra | Supabase (Auth, RLS, Storage, Realtime) |

## Key decisions
- **Go worker** (not Python) — goroutines beat threadpools for concurrent I/O; Asynq is Go-native
- **Mistral OCR API** (not Docling/Surya) — keeps worker pure Go, handles handwriting
- **Multi-user from day one** — `user_id` on all rows, RLS enforced at DB layer
- **Offline capture** — expo-sqlite queue, expo-task-manager sync, SHA-256 dedup on server
- **Supabase Realtime** (not polling) — pushes `documents.status` and `actions_status` changes to mobile
- **Action analysis is non-critical** — runs after `indexed` is set; errors set `actions_status = failed` but never fail or requeue the Asynq job
- **Claude Sonnet for action analysis (not Haiku)** — better reasoning on implicit actions (e.g. "nut-free snack" implies both a task and a reminder); cost is negligible at family scale

## Job contract (FastAPI → Go worker)
Lives in `infra/contracts/jobs.md`. Both sides implement against this — change them together.
```json
{ "document_id": "uuid", "user_id": "uuid", "image_url": "string", "image_hash": "string (SHA-256)", "attempt": 1 }
```

## Document status lifecycle
```
documents.status:        pending → queued → processing → indexed  (or failed after 3 retries → DLQ)
documents.actions_status:                               analyzing → ready  (or failed — non-blocking)
```
`actions_status` is independent — a document can be `indexed` while actions are still `analyzing`.

## Action types
Four structured action types extracted by Claude Sonnet via tool calling:
| Type | Example trigger |
|---|---|
| `calendar_event` | Birthday party, field trip, bake sale date |
| `task` | Sign permission slip, buy birthday present, RSVP |
| `reminder` | Bring $5 cash Friday, nut-free snack required |
| `note` | Key info with no deadline (teacher name, dress code) |

Action lifecycle: `suggested → accepted → dismissed → completed`
Actions live in `document_actions`; payload shape is type-specific JSONB.

## Vector search rules
- Embeddings live in `document_chunks`, not `documents` — one row per chunk, not per document
- The HNSW index uses `vector_cosine_ops` — **all queries must use the `<=>` operator** (cosine distance)
- Using `<->` (L2) or `<#>` (inner product) bypasses the index and causes a full sequential scan
- Correct pattern: `ORDER BY embedding <=> $1 LIMIT n`