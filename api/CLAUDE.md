# API

FastAPI service. Thin ingest, query, and action retrieval layer — no processing logic lives here.

## Responsibilities
- **Ingest** — validate JWT, deduplicate via `image_hash`, store image in Supabase Storage, create `documents` row, enqueue Asynq job, return 202
- **Query** — accept natural language search, run RAG via LlamaIndex + Claude Sonnet, return results
- **Actions** — serve action suggestions extracted by the worker; accept accept/dismiss updates from mobile

## Routers
| File | Routes |
|---|---|
| `routers/ingest.py` | `POST /documents`, `GET /documents` |
| `routers/actions.py` | `GET /documents/{id}/actions` |

## What this is NOT
- No OCR, classification, chunking, embedding, or action analysis — all of that is the worker's job
- No direct vector search — LlamaIndex handles that on the query path

## Job contract
Produced and enqueued by this service. Defined in `infra/contracts/jobs.md` — do not change without updating the worker too.
```json
{ "document_id": "uuid", "user_id": "uuid", "image_url": "string", "image_hash": "string (SHA-256)", "attempt": 1 }
```

## Status transitions owned by this service
- Creates `documents` row at status `pending`
- Sets status to `queued` after successfully enqueuing the Asynq job

## Auth
- Validate Supabase JWT on every request — reject anything without a valid Bearer token
- Extract `user_id` from the JWT; never trust a `user_id` from the request body
- The shared `_extract_user_id()` helper lives in each router (ingest.py, actions.py) — keep them in sync if the JWT logic changes

## GET /documents/{id}/actions response shape
```json
{
  "document_id": "uuid",
  "actions_status": "ready | analyzing | failed | null",
  "actions": [
    {
      "id": "uuid",
      "action_type": "calendar_event | task | reminder | note",
      "status": "suggested | accepted | dismissed | completed",
      "payload": { /* type-specific fields */ },
      "created_at": "ISO 8601"
    }
  ]
}
```

## Stack
- FastAPI (Python)
- LlamaIndex for RAG on the query path (pgvector → Qdrant when >5-10M vectors)
- Claude Sonnet with tool calling for natural language search
- Redis + Asynq client for job enqueueing

## Vector search rules
- Embeddings live in `document_chunks`, not `documents`
- All queries must use `<=>` (cosine distance) to hit the HNSW index
