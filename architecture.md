# The Fridge Door — Foundation Architecture Plan

## Context

Parents receive a constant stream of physical documents from their kids' schools — homework, assignments, artwork, permission slips, flyers. Managing and finding information buried across dozens of papers is a real, daily pain point. This app solves it by turning a phone camera into a smart document inbox: capture → OCR → embed → search. The user wants to leverage their existing RAG/agentic expertise to build something genuinely useful for personal use that can eventually scale into a product.

---

## Problem Statement

> Parents accumulate large volumes of physical school documents with no practical way to search or retrieve specific information later. The goal is a mobile-first application that lets users quickly capture documents, automatically extract and index their contents via OCR + vector embeddings, and then search across them using natural language — powered by an LLM with tool-calling for agentic retrieval.

**Core user flows:**
1. **Capture** — point camera at paper, tap, done (< 5 seconds)
2. **Auto-process** — OCR + embed + store happen in background via queue
3. **Search** — "What time is the field trip?" → accurate answer with source doc

---

## Happy Path Workflow — Capture to Search

```
╔══════════════════════════════════════════════════════════════════════╗
║                         MOBILE DEVICE                               ║
║                                                                      ║
║  ┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐  ║
║  │  1. CAPTURE │────▶│  2. ON-DEVICE    │────▶│  3. UPLOAD       │  ║
║  │  expo-camera│     │  PRE-OCR         │     │                  │  ║
║  │             │     │  Apple Vision    │     │ POST /documents  │  ║
║  │             │     │  (iOS) / ML Kit  │     │ → 202 Accepted   │  ║
║  │             │     │  (Android)       │     │ (returns in      │  ║
║  │             │     │                  │     │  ~50ms)          │  ║
║  │             │     │  Instant preview │     │                  │  ║
║  │             │     │  shown to user   │     │ job_id returned  │  ║
║  └─────────────┘     └──────────────────┘     └────────┬─────────┘  ║
║                                                        │            ║
║  [If offline: expo-sqlite queues locally,              │            ║
║   expo-task-manager syncs when back online]            │            ║
╚════════════════════════════════════════════════════════╪════════════╝
                                                         │
                                         HTTPS + Supabase JWT
                                                         │
╔════════════════════════════════════════════════════════▼════════════╗
║                   FASTAPI  (Ingest Endpoint — Python)               ║
║                                                                      ║
║  ┌──────────────────────────────────────────────────────────────┐   ║
║  │  4. RECEIVE + ENQUEUE  (thin layer, returns fast)            │   ║
║  │                                                              │   ║
║  │  a) Validate JWT (Supabase Auth)                             │   ║
║  │  b) Save raw image → Supabase Storage                        │   ║
║  │  c) INSERT documents row  (status: "pending")                │   ║
║  │  d) Enqueue job → Redis (Asynq format)                       │   ║
║  │  e) Return 202 + job_id to mobile                            │   ║
║  └──────────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════╝
                                  │
                            job payload
                     { id, user_id, image_url }
                                  │
╔═════════════════════════════════▼════════════════════════════════════╗
║                      REDIS QUEUE  (Asynq)                           ║
║                                                                      ║
║   job: { id, user_id, image_url, attempt: 1 }                       ║
║                                                                      ║
║   retry policy:  3 attempts, exponential backoff (5s → 30s → 2min) ║
║   dead-letter:   exhausted jobs → "failed" status + alert           ║
╚═════════════════════════════════╪════════════════════════════════════╝
                                  │
                     worker picks up job
                  (scale horizontally by adding workers)
                                  │
╔═════════════════════════════════▼════════════════════════════════════╗
║               PROCESSING WORKER  (Go + Asynq)                       ║
║                  [single binary, independently scalable]            ║
║                                                                      ║
║  Goroutines run independent I/O steps concurrently where possible   ║
║                                                                      ║
║  ┌───────────────┐                                                   ║
║  │  5. OCR       │  HTTP ──▶  Mistral OCR API                       ║
║  │               │            • Multimodal (image-in)               ║
║  │               │            • Handles printed + handwriting       ║
║  │               │            • Returns structured Markdown text    ║
║  │               │            • ~$1 per 1,000 pages                 ║
║  └───────┬───────┘                                                   ║
║          │                                                           ║
║  ┌───────▼───────┐                                                   ║
║  │  6. CLASSIFY  │  HTTP ──▶  Claude Haiku API                      ║
║  │               │            • Auto-tags category                  ║
║  │               │            • "Homework", "Permission Slip",      ║
║  │               │              "Art Project", "Schedule", etc.     ║
║  │               │            • ~$0.001 per document                ║
║  └───────┬───────┘                                                   ║
║          │                                                           ║
║  ┌───────▼───────┐                                                   ║
║  │  7. EMBED     │  HTTP ──▶  Nomic Embed API (self-hosted)         ║
║  │               │            • Chunks text (~512 tokens)           ║
║  │               │            • 768-dim vectors per chunk           ║
║  │               │            • Free (self-hosted container)        ║
║  └───────┬───────┘                                                   ║
║          │                                                           ║
║  ┌───────▼───────┐                                                   ║
║  │  8. STORE     │  pgx ───▶  Supabase (PostgreSQL + pgvector)      ║
║  │               │            • UPDATE documents: status, ocr_text, ║
║  │               │              category, metadata                  ║
║  │               │            • INSERT embeddings rows              ║
║  └───────────────┘                                                   ║
║                                                                      ║
║  On any step failure → job returns to queue → retry w/ backoff      ║
║  After 3 failures   → dead-letter queue → status: "failed"          ║
╚══════════════════════════════════════════════════════════════════════╝
                                  │
                    Supabase Realtime (status push to device)
                                  │
╔═════════════════════════════════▼════════════════════════════════════╗
║                         MOBILE DEVICE                               ║
║                                                                      ║
║  Status:  pending ──▶ processing ──▶ indexed  (or failed)           ║
║  Doc appears in user's library automatically when indexed           ║
╚══════════════════════════════════════════════════════════════════════╝


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SEARCH FLOW  (when user queries)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  User types: "What time is Tommy's field trip on Friday?"
       │
       ▼  POST /query  (FastAPI)
  ┌────────────────────────────────────────────────────────────────┐
  │  QUERY PIPELINE  (FastAPI + LlamaIndex + Claude API)           │
  │                                                                │
  │  a) Query → Nomic Embed API → 768-dim query vector             │
  │                                                                │
  │  b) pgvector cosine similarity search                          │
  │     → Top-K most relevant chunks returned                      │
  │     → Filtered by user_id (RLS enforced at DB layer)           │
  │                                                                │
  │  c) LlamaIndex injects retrieved chunks into Claude prompt     │
  │                                                                │
  │  d) Claude Sonnet (tool calling enabled):                      │
  │     • Can call search_documents() for multi-hop retrieval      │
  │     • Reasons over retrieved context                           │
  │     • Returns grounded answer + source citation                │
  └────────────────────────────────────────────────────────────────┘
       │
       ▼
  "The field trip is Friday, April 11th at 9:00 AM.
   Bus departs at 8:45 AM. Chaperones meet in the gym.
   [Source: Field Trip Permission Slip · captured Apr 3]"
```

---

## Document Status Lifecycle

```
pending → queued → processing → indexed
                       │
                       └── failed  (after 3 retries → DLQ → alert)
```

Status lives on the `documents` row. Supabase Realtime pushes changes to the mobile client in real time — no polling required.

---

## Technology Stack

| Layer | Choice | Language | Rationale |
|---|---|---|---|
| Mobile | Expo + React Native | TypeScript | Cross-platform, OTA updates, EAS builds |
| Ingest API | FastAPI | Python | Thin endpoint only: validate, store, enqueue |
| Queue | Redis + Asynq | — | Persistent job queue, retry/backoff, DLQ |
| Processing Worker | Go + Asynq | Go | Goroutines for concurrent I/O, single binary, horizontally scalable |
| OCR | Mistral OCR API | HTTP | Multimodal, handles handwriting, no Python ML dependency |
| Auto-classify | Claude Haiku API | HTTP | Cheap (~$0.001/doc), fast tagging |
| Embeddings | Nomic Embed v1.5 (self-hosted) | HTTP | Free, outperforms OpenAI embeddings, 8k context |
| RAG Orchestration | LlamaIndex | Python | RAG-native, native pgvector integration |
| LLM (search) | Claude Sonnet API | HTTP | Best tool calling, 200k context, document understanding |
| Vector DB (MVP) | PostgreSQL + pgvector | — | One DB for everything, Supabase managed |
| Vector DB (scale) | Qdrant | — | Migrate when >5-10M vectors; LlamaIndex makes it seamless |
| Auth + Infra | Supabase | — | Auth, RLS, Storage, Realtime — all managed |
| On-device OCR | Apple Vision / ML Kit | Native | Instant preview before upload completes |
| Offline queue | expo-sqlite + expo-task-manager | TypeScript | Local capture queue, idempotent server-side dedup |

---

## Why Go for the Worker (not Python)

- **Goroutines** enable concurrent pipeline steps (download + DB write happen in parallel where not dependent)
- **Asynq** is Go-native Redis queue — same Redis instance, same job format, no extra infra
- **`pgx`** is one of the fastest Postgres drivers across any language — native pgvector support
- **Single binary** — no virtualenvs, no dependency conflicts, trivial Docker image (`FROM scratch`)
- **Horizontal scaling** — add worker replicas behind the same Redis queue with zero coordination overhead

The original Docling + Surya OCR stack (Python/PyTorch) is replaced by **Mistral OCR API** — school documents are clean enough inputs that a well-trained multimodal API matches accuracy without requiring Python ML services. This keeps the worker pure Go.

---

## Confirmed Decisions

| Decision | Choice | Implication |
|---|---|---|
| **User scope** | Multi-user from day one | `user_id` on all rows; Supabase Auth + RLS from the start; all queries namespaced per user |
| **Document tagging** | LLM auto-classify at ingest | Claude Haiku tags in the Go worker pipeline; stored in `documents.metadata`; user can override in UI |
| **Offline capture** | Capture offline, sync later | expo-sqlite queues locally; expo-task-manager syncs on reconnect; server deduplicates by image hash |
| **Worker language** | Go | Goroutines, Asynq, pgx — compiled, fast, independently scalable |
| **OCR approach** | Mistral OCR API (HTTP) | Eliminates Python ML dependency in worker; enables pure Go binary |

---

## Estimated MVP Cost (Monthly)

| Component | Cost |
|---|---|
| Expo EAS (builds) | $0–25 |
| FastAPI hosting (Railway/Render) | $15–50 |
| Go worker hosting (Railway/Render) | $10–30 |
| Redis (managed) | $10–20 |
| Supabase (Postgres + Storage + Realtime) | $25–100 |
| Mistral OCR API (~1,000 pages/mo) | ~$1 |
| Claude API (Haiku classify + Sonnet search) | $10–100 |
| Nomic Embed (self-hosted container) | $0–15 |
| **Total** | **~$70–340** |

---

## Repository Structure

**Monorepo.** Services are tightly coupled by contract (the Asynq job payload FastAPI writes must match what the Go worker reads; API shapes must match what mobile consumes). A monorepo makes cross-cutting changes atomic, keeps shared infra in one place, and removes coordination overhead for a solo developer. Each service still deploys independently via CI path filters.

```
the-fridge-door/
├── mobile/                        # Expo + React Native (TypeScript)
│   ├── app/                       # Expo Router screens
│   │   ├── (tabs)/
│   │   │   ├── capture.tsx        # Camera capture screen
│   │   │   ├── library.tsx        # Document library
│   │   │   └── search.tsx         # Search / chat interface
│   │   └── _layout.tsx
│   ├── components/
│   ├── lib/
│   │   ├── api.ts                 # FastAPI client
│   │   ├── sync.ts                # Offline queue (expo-sqlite)
│   │   └── realtime.ts            # Supabase Realtime status listener
│   ├── app.json
│   └── package.json
│
├── api/                           # FastAPI — ingest + query (Python)
│   ├── routers/
│   │   ├── ingest.py              # POST /documents  → 202 + job_id
│   │   └── query.py               # POST /query      → RAG answer
│   ├── services/
│   │   ├── storage.py             # Supabase Storage upload
│   │   ├── queue.py               # Asynq job enqueue
│   │   └── rag.py                 # LlamaIndex + Claude search pipeline
│   ├── requirements.txt
│   └── Dockerfile
│
├── worker/                        # Go processing worker (Asynq)
│   ├── cmd/
│   │   └── worker/
│   │       └── main.go            # Asynq server entrypoint
│   ├── internal/
│   │   ├── jobs/
│   │   │   └── process_document.go  # Orchestrates the pipeline
│   │   ├── ocr/
│   │   │   └── mistral.go         # Mistral OCR API client
│   │   ├── classify/
│   │   │   └── haiku.go           # Claude Haiku category tagging
│   │   ├── embed/
│   │   │   └── nomic.go           # Nomic Embed HTTP client
│   │   └── db/
│   │       └── documents.go       # pgx queries (update status, insert embeddings)
│   ├── go.mod
│   └── Dockerfile
│
├── infra/                         # Shared infrastructure
│   ├── docker-compose.yml         # Local dev: Redis, Postgres+pgvector, Nomic Embed
│   ├── supabase/
│   │   └── migrations/            # SQL schema + RLS policies (source of truth)
│   │       ├── 001_init.sql
│   │       ├── 002_rls.sql
│   │       └── 003_pgvector.sql
│   └── contracts/
│       └── jobs.md                # Canonical Asynq job payload schema
│                                  # (Python enqueue + Go dequeue implement against this)
│
├── docs/
│   └── architecture.md            # This document
│
└── .github/
    └── workflows/
        ├── mobile.yml             # Triggers on: mobile/**
        ├── api.yml                # Triggers on: api/**
        └── worker.yml             # Triggers on: worker/**
```

### Key Architectural Boundary: The Job Contract

The Asynq job payload is the critical shared contract between the Python ingest API and the Go worker. It lives in `infra/contracts/jobs.md` and both sides implement against it. When the schema changes, both `api/` and `worker/` are updated in the same commit.

```json
// infra/contracts/jobs.md — canonical job payload
{
  "document_id": "uuid",
  "user_id":     "uuid",
  "image_url":   "string (Supabase Storage path)",
  "image_hash":  "string (SHA-256, for dedup)",
  "attempt":     1
}
```

---

## Next Steps

1. **Data model** — full Postgres schema with RLS policies (`documents`, `embeddings`, `users`)
2. **API contracts** — FastAPI ingest + query endpoint request/response shapes
3. **Go worker scaffold** — Asynq server, job handler, pipeline stages
4. **Local dev environment** — `infra/docker-compose.yml` for Redis, Postgres+pgvector, Nomic Embed container

---

## Verification

End-to-end happy path test:
1. Capture test image in Expo app → POST to FastAPI → 202 returned in <100ms
2. Job appears in Redis → Go worker picks it up
3. Mistral OCR extracts text → Haiku classifies → Nomic embeds → pgvector stores
4. Document status updates to "indexed" → Supabase Realtime pushes to mobile
5. User queries → LlamaIndex + Claude Sonnet returns grounded answer with source citation

Target latency: upload response <100ms · end-to-end indexing <30s · search response <3s
