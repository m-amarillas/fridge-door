# The Fridge Door

> Snap a school paper. Let AI figure out what you need to do about it.

Parents receive a constant stream of physical documents from their kids' schools — permission slips, flyers, homework, field trip forms, birthday party invites. Most end up in a pile, forgotten until it's too late. **The Fridge Door** doesn't just digitize them — it reads them and tells you what to do next.

Snap a permission slip and the app surfaces: *"Sign and return by Friday. Field trip is April 11th — want me to add it to your calendar?"* Snap a flyer and it picks out the RSVP deadline, the dress code, the $5 cash requirement. Every document becomes a set of actions you can accept, dismiss, or complete — without reading the paper yourself.

When you need to dig something up later, natural language search has you covered: *"What time does the bus leave for Tommy's field trip?"* returns a grounded answer with a citation to the original document.

---

## What the agent does

When a document is captured, Claude Sonnet analyzes the full OCR text and extracts **structured actions** using tool calling — reasoning over implicit meaning, not just explicit text:

| Action type | Example trigger |
|---|---|
| `calendar_event` | "Field trip April 11th · bus at 8:45 AM" |
| `task` | "Sign and return permission slip by Friday" |
| `reminder` | "Bring $5 cash · nut-free snack required" |
| `note` | "Dress code: blue and gold · teacher: Mrs. Reyes" |

Actions move through a lifecycle — `suggested → accepted → dismissed → completed` — and live independently from the document so they can be acted on without re-reading anything.

The distinction from a document scanner: **the app understands what the paper is asking of you.** A scanner gives you a JPEG. The Fridge Door gives you a to-do list.

---

## How it works

```
Capture → OCR → Classify → Extract actions → Embed → Index → Search
```

1. **Snap** — point your camera at any school document. Done in under 5 seconds.
2. **Analyze** — OCR extracts the text, Claude Sonnet reasons over it and surfaces actions, embeddings are stored. All in the background.
3. **Act** — accept a calendar invite, mark a task done, dismiss what's irrelevant.
4. **Search** — ask a question in plain English when you need to find something later.

```
User: "What time is Tommy's field trip on Friday?"

→  "The field trip is Friday, April 11th at 9:00 AM.
    Bus departs at 8:45 AM. Chaperones meet in the gym.
    [Source: Field Trip Permission Slip · captured Apr 3]"
```

---

## Architecture

```
╔══════════════════════════════════╗
║  Mobile (Expo + React Native)    ║
║  expo-camera → capture screen    ║
║  expo-sqlite → offline queue     ║
║  Supabase Realtime → live status ║
╚══════════════╤═══════════════════╝
               │  HTTPS + Supabase JWT
               ▼
╔══════════════════════════════════╗
║  FastAPI  (Python)               ║
║  Validate JWT → store image      ║
║  → INSERT documents row          ║
║  → Enqueue job in Redis          ║
║  → Return 202 + job_id           ║
╚══════════════╤═══════════════════╝
               │  Asynq job
               ▼
╔══════════════════════════════════╗
║  Go Worker  (Asynq)              ║
║  ├─ OCR       → Mistral OCR API  ║
║  ├─ Classify  → Claude Haiku     ║
║  ├─ Actions   → Claude Sonnet    ║
║  ├─ Embed     → Nomic Embed v1.5 ║
║  └─ Store     → pgvector / pgx   ║
╚══════════════╤═══════════════════╝
               │  Supabase Realtime push
               ▼
╔══════════════════════════════════╗
║  Search (FastAPI + LlamaIndex)   ║
║  Query → embed → cosine search   ║
║  → Claude Sonnet (tool calling)  ║
║  → Grounded answer + citation    ║
╚══════════════════════════════════╝
```

**Document status lifecycle:**
```
pending → queued → processing → indexed
                                    └─ actions: analyzing → ready
```

Status changes are pushed to the mobile client via Supabase Realtime — no polling.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Mobile | Expo SDK 54, React Native, expo-router | Cross-platform, OTA updates, offline-first primitives |
| Ingest API | FastAPI (Python) | Thin layer: validate, store, enqueue — returns in ~50ms |
| Queue | Redis + Asynq | Persistent jobs, retry/backoff, dead-letter queue |
| Processing worker | **Go** + Asynq | Goroutines for concurrent I/O; single binary; horizontally scalable |
| OCR | Mistral OCR API | Multimodal, handles handwriting, keeps worker pure Go |
| Auto-classify | Claude Haiku | ~$0.001/doc for category tagging |
| Action extraction | Claude Sonnet (tool calling) | Better reasoning on implicit actions (e.g. "nut-free snack" → task + reminder) |
| Embeddings | Nomic Embed v1.5 (self-hosted) | 768-dim, outperforms OpenAI embeddings, free |
| RAG | LlamaIndex (Python) | Native pgvector integration, query path only |
| LLM search | Claude Sonnet (tool calling) | Multi-hop retrieval, 200k context, source citation |
| Vector DB | PostgreSQL + pgvector (Supabase) | One DB for everything at MVP scale; migrate to Qdrant at >5M vectors |
| Auth / Infra | Supabase | Auth, RLS, Storage, Realtime — all managed |

---

## Monorepo structure

```
fridge-door/
├── mobile/          Expo + React Native (TypeScript)
├── api/             FastAPI — ingest endpoint + RAG query (Python)
├── worker/          Go processing worker (Asynq)
├── infra/           Supabase config, migrations, job contract
├── architecture.md  Full decision log
└── Makefile         Local dev orchestration
```

Each service deploys independently. The shared contract between `api/` and `worker/` is the Asynq job payload documented in `infra/contracts/jobs.md` — both sides implement against it, and schema changes update both in the same commit.

---

## Local development

**Prerequisites:** Docker, Go 1.22+, Python 3.12+, Node 20+, [Supabase CLI](https://supabase.com/docs/guides/cli), [Overmind](https://github.com/DarthSim/overmind)

```bash
# 1. Start Supabase (local Postgres + pgvector + Auth + Realtime)
make build

# 2. Copy and fill env files
cp api/.env.example api/.env
cp worker/.env.example worker/.env
cp mobile/.env.example mobile/.env

# 3. Start all services
make up
```

Individual services:

```bash
make api      # FastAPI on :8000
make worker   # Go worker (connects to Redis + Supabase)
make mobile   # Expo dev server
```

---

## Key design decisions

**Go worker, not Python** — Goroutines beat thread pools for the concurrent I/O pipeline (OCR → classify → embed → store). Asynq is Go-native. `pgx` is one of the fastest Postgres drivers in any language. The result is a single compiled binary with a trivial Docker image.

**Mistral OCR API, not an on-device ML stack** — School documents are clean enough that a well-trained multimodal API matches local accuracy without requiring Python ML services in the worker. This keeps the worker pure Go.

**Multi-user from day one** — `user_id` on every row, Supabase RLS enforced at the database layer. All queries are namespaced per user — the search path never leaks documents across families.

**Offline capture** — `expo-sqlite` queues documents locally when offline. `expo-task-manager` syncs on reconnect. The server deduplicates by SHA-256 image hash so a retry never creates a duplicate document.

**Action analysis is non-critical** — runs after a document is `indexed`. Errors set `actions_status = failed` but never fail or requeue the main Asynq job. A document that can be searched is always better than a document that failed because action extraction crashed.

