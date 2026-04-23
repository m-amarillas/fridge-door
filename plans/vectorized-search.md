# Vectorized Search: Filter Documents by Natural Language Query

## Goal

Wire up the existing search bar on the home screen to the pgvector embeddings already stored in `document_chunks`. When a user types a query, the document list filters down to the documents whose embedded OCR text is most semantically similar to the query. Clearing the search bar restores the full document list.

This implements the **retrieval step of RAG** — HNSW index, cosine similarity, nearest neighbor ranking — without the generation step. There is no LLM synthesizing an answer from retrieved chunks; the user receives the ranked source documents and reads them directly. Full RAG (retrieval + LlamaIndex + Claude answer synthesis) is a later phase.

---

## Current State

| Layer | Status |
|---|---|
| Search bar UI | Exists in `mobile/app/index.tsx` — captures text, not wired to anything |
| `document_chunks` table | Populated with 768-dim Nomic Embed v1.5 vectors per chunk |
| HNSW index | `vector_cosine_ops`, must use `<=>` operator |
| `POST /search` API endpoint | Does not exist |
| Nomic Embed client (query side) | Does not exist in Python/API |

---

## Architecture

```
User types query
    ↓  (300ms debounce)
Mobile calls POST /search { query, limit }
    ↓
FastAPI: embed query via Nomic Embed API (task_type: "search_query")
    ↓
SQL: vector similarity search on document_chunks (user-scoped, <=> operator)
    ↓
Deduplicate by document_id, take best score per document, rank, limit N
    ↓
Join with documents table, sign image URLs
    ↓
Return ranked document array (same shape as GET /documents)
    ↓
Mobile replaces document list with search results
    ↓
User clears query → fetchDocuments() restores full list
```

**Key constraint:** Query embedding must use task_type `"search_query"` (asymmetric). The worker uses `"search_document"` for indexing. These must not be swapped.

---

## Files to Create

### `api/routers/search.py`
New FastAPI router with a single endpoint: `POST /search`.

- Validates JWT (extract `user_id`)
- Calls embed service to get 768-dim query vector
- Runs SQL to find top matching document_ids by cosine similarity
- Joins with `documents` to get metadata + signs image URLs
- Returns array of document objects, ranked by relevance score

**Request body:**
```json
{ "query": "string (1–500 chars)", "limit": 10 }
```

**Response:** Array of document objects — same shape as `GET /documents` so the mobile client can reuse the `Document` type unchanged.

### `api/services/embed.py`
Thin async wrapper around the Nomic Embed HTTP API, used by the query path.

- `async embed_query(text: str) -> list[float]` — calls Nomic Embed with `task_type: "search_query"`, returns 768-dim vector
- Respects `NOMIC_EMBED_URL` env var (same as the Go worker)
- Returns zero vector of length 768 if `NOMIC_EMBED_URL` is unset (dev fallback — results will be meaningless but won't crash)

### `mobile/lib/search.ts`
API client for the search endpoint.

- `searchDocuments(query: string, limit?: number): Promise<Document[]>` — calls `POST /search`, returns `Document[]`
- Reuses the existing `getAuthHeaders()` or equivalent JWT attach pattern from `mobile/lib/documents.ts`

---

## Files to Modify

### `api/main.py`
Register the new search router:
```python
from api.routers import search
app.include_router(search.router)
```

### `mobile/app/index.tsx`
Wire the search bar to `searchDocuments()`:

1. Add `isSearching: boolean` state alongside the existing `query` state
2. Add a `useEffect` that debounces `query` by 300ms:
   - If `query` is empty → call `fetchDocuments()` to restore full list
   - If `query` is non-empty → call `searchDocuments(query)` and replace `documents` state
3. Show a subtle loading indicator (ActivityIndicator in the search bar) while `isSearching` is true
4. Show a "No results" empty state when search returns an empty array
5. Do not modify `fetchDocuments()` or the existing document list rendering — search results use the same `Document[]` state so `DocumentCard` renders identically

---

## SQL Query (inside `api/routers/search.py`)

```sql
WITH top_chunks AS (
    SELECT
        document_id,
        embedding <=> $1 AS score
    FROM document_chunks
    WHERE user_id = $2
    ORDER BY embedding <=> $1 ASC
    LIMIT $3
)
SELECT DISTINCT ON (document_id) document_id, score
FROM top_chunks
ORDER BY document_id, score ASC
```

Then in Python: sort the deduped rows by score, take top N, fetch full document rows by ID list.

**Why two steps (not one big JOIN)?**  
The HNSW index is used for the inner `ORDER BY embedding <=> $1 LIMIT K` scan. A GROUP BY or outer JOIN on top of that does not break index usage — but splitting into a CTE + Python dedup keeps the SQL readable and the index scan isolated.

**Operator reminder:** `<=>` (cosine distance) is the only operator that hits the HNSW index. Do not use `<->` or `<#>`.

---

## Environment Variables

No new env vars needed. The search endpoint reuses:
- `NOMIC_EMBED_URL` — already set in `infra/docker-compose.yml` and Makefile
- `DATABASE_URL` / Supabase connection — already used by the API

---

## Out of Scope (this phase)

- Generation step (LlamaIndex + Claude answer synthesis from retrieved chunks) — planned for a later phase
- Relevance score display in the UI — scores are used for ranking only, not shown
- Search history or saved searches
- Filtering by document type or date alongside semantic search
- Pagination of search results (limit=10 is sufficient for now)

---

## Implementation Order

1. `api/services/embed.py` — embed service (no dependencies)
2. `api/routers/search.py` — search endpoint (depends on embed service)
3. `api/main.py` — register router
4. `mobile/lib/search.ts` — API client
5. `mobile/app/index.tsx` — wire search bar with debounce + loading/empty states
