-- =============================================================================
-- Migration: 001 initial schema
-- =============================================================================
-- Creates the full initial data layer for The Fridge Door:
--   - Extensions (pgvector)
--   - documents table with status lifecycle and OCR output (no embedding)
--   - document_chunks table with per-chunk text and embeddings
--   - Indexes for dedup, vector similarity search, and common query patterns
--   - Row Level Security so users only see their own data
--   - Storage bucket for raw document images with per-user access policies
--
-- Embedding design rationale:
--   Embeddings live in document_chunks, not documents. School papers vary widely
--   in length (a lunch menu vs a multi-page IEP). A single vector per document
--   is a lossy summary that degrades semantic search on longer content. Chunking
--   each document's OCR text and embedding each chunk independently gives the
--   query layer (LlamaIndex) the granularity it needs for accurate retrieval.
--
--   When the vector count grows past ~5M chunks, the embedding column migrates
--   out of document_chunks and into Qdrant. Postgres keeps chunk text + metadata;
--   Qdrant keeps the vectors. LlamaIndex treats both as swappable backends.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------

-- vector: the pgvector extension that adds the vector column type and similarity
-- search operators. Required for storing Nomic Embed v1.5 embeddings (768 dims)
-- and running cosine-similarity queries at search time.
create extension if not exists "vector";


-- -----------------------------------------------------------------------------
-- Enum: document_status
-- -----------------------------------------------------------------------------

-- Represents every state a document can be in throughout its processing lifecycle.
-- The Go worker and FastAPI ingest layer both write to this column.
-- Lifecycle: pending → queued → processing → indexed
--            any state → failed (after 3 attempts, worker moves job to DLQ)
create type document_status as enum (
  'pending',      -- mobile has captured the image but upload hasn't started
  'queued',       -- FastAPI accepted the upload and enqueued the Asynq job
  'processing',   -- Go worker has dequeued the job and is actively working on it
  'indexed',      -- OCR, classification, chunking, embedding all succeeded
  'failed'        -- worker exhausted retries; job is in the dead-letter queue
);


-- -----------------------------------------------------------------------------
-- Table: documents
-- -----------------------------------------------------------------------------

-- One row per physical school document captured by the mobile app.
-- This table is the source of truth for document metadata and processing state.
-- It intentionally holds no embedding — see document_chunks below.
create table documents (
  -- Surrogate primary key. Generated server-side so the mobile client can
  -- receive it in the 202 response and use it to subscribe to Realtime updates.
  id            uuid primary key default gen_random_uuid(),

  -- Foreign key to Supabase Auth. Cascade delete ensures all of a user's
  -- documents and their chunks are removed if their account is deleted.
  user_id       uuid not null references auth.users(id) on delete cascade,

  -- Current position in the processing lifecycle (see enum above).
  -- Supabase Realtime watches this column and pushes changes to the mobile client.
  status        document_status not null default 'pending',

  -- Supabase Storage path for the raw image, e.g. "documents/<user_id>/<doc_id>.jpg".
  -- The Go worker reads this URL to fetch the image for OCR.
  image_url     text not null,

  -- SHA-256 hash of the raw image bytes, computed by the mobile client before upload.
  -- Used server-side to detect and reject duplicate submissions without reading
  -- the image content. Paired with user_id in a unique index below.
  image_hash    text not null,

  -- Full OCR output returned by the Mistral OCR API, stored as markdown.
  -- NULL until the worker reaches the 'processing' stage.
  -- The worker then splits this into chunks and writes to document_chunks.
  ocr_text      text,

  -- Document category assigned by Claude Haiku during auto-classification,
  -- e.g. "permission_slip", "report_card", "newsletter", "lunch_menu".
  -- NULL until classification completes inside the worker.
  document_type text,

  -- Tracks how many times the Asynq worker has attempted this job.
  -- The worker increments this on each attempt. At attempt = 3 the job
  -- is moved to the dead-letter queue and status is set to 'failed'.
  attempt       int not null default 0,

  -- Freeform JSON for any additional data the worker or API wants to store
  -- without a schema change, e.g. page count, confidence scores, Haiku's
  -- raw classification response.
  metadata      jsonb not null default '{}',

  created_at    timestamptz not null default now(),

  -- Updated by the worker each time status changes. The trigger below keeps
  -- this current automatically so callers don't need to set it explicitly.
  updated_at    timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- Table: document_chunks
-- -----------------------------------------------------------------------------

-- One row per chunk of a document's OCR text.
-- The Go worker splits ocr_text into overlapping chunks, embeds each one via
-- Nomic Embed v1.5, and writes a row here per chunk.
--
-- At query time, LlamaIndex searches this table by embedding similarity,
-- retrieves the matching chunk_text values, and passes them as context to
-- Claude Sonnet. It then joins back to documents for metadata (type, image_url).
--
-- Future migration path: when vector count exceeds ~5M, drop the embedding
-- column from this table and store vectors in Qdrant instead. chunk_text and
-- all other columns stay here in Postgres as the authoritative text store.
create table document_chunks (
  id            uuid primary key default gen_random_uuid(),

  -- The parent document. Cascade delete removes all chunks when a document
  -- is deleted, keeping the two tables in sync automatically.
  document_id   uuid not null references documents(id) on delete cascade,

  -- Denormalized for query efficiency — avoids a join to documents when
  -- LlamaIndex needs to apply per-user RLS filtering during vector search.
  user_id       uuid not null references auth.users(id) on delete cascade,

  -- Zero-based position of this chunk within the document.
  -- Preserved so the query layer can reconstruct reading order if needed,
  -- e.g. when returning surrounding context around a matched chunk.
  chunk_index   int not null,

  -- The actual text content of this chunk, sliced from ocr_text by the worker.
  -- This is what gets returned to Claude Sonnet as RAG context.
  chunk_text    text not null,

  -- 768-dimensional embedding produced by Nomic Embed v1.5 for this chunk's text.
  -- Used by LlamaIndex for cosine similarity search at query time.
  -- NULL briefly between chunk creation and embedding write (same worker task).
  embedding     vector(768),

  created_at    timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- Trigger: keep updated_at current on documents
-- -----------------------------------------------------------------------------

-- Automatically sets updated_at to now() on every row update so the worker
-- and API don't need to explicitly pass the timestamp in every status write.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger documents_updated_at
  before update on documents
  for each row execute procedure set_updated_at();


-- -----------------------------------------------------------------------------
-- Indexes: documents
-- -----------------------------------------------------------------------------

-- Prevents the same physical document from being stored twice for the same user.
-- The mobile client sends the SHA-256 hash with the upload; FastAPI checks this
-- index before creating a documents row and returns 409 if already present.
create unique index documents_user_hash_idx
  on documents(user_id, image_hash);

-- Supports fast lookup of all documents for a given user, the most common
-- query pattern from both the mobile client and the query API.
create index documents_user_id_idx
  on documents(user_id);

-- Supports filtering by status, e.g. finding all 'failed' jobs for a retry
-- sweep, or all 'indexed' documents when building a search index snapshot.
create index documents_status_idx
  on documents(status);


-- -----------------------------------------------------------------------------
-- Indexes: document_chunks
-- -----------------------------------------------------------------------------

-- HNSW index for approximate nearest-neighbor cosine similarity search.
-- Chosen over IVFFlat for three reasons:
--   1. Better recall — graph-based traversal consistently outperforms IVFFlat's
--      centroid clustering, especially as the table grows.
--   2. Handles continuous inserts — IVFFlat fixes its centroids at build time,
--      so new vectors don't update the clusters. HNSW updates the graph on each
--      insert, which matters for a document capture app with constant new chunks.
--   3. Builds on an empty table — IVFFlat requires existing rows to cluster;
--      HNSW does not.
--
-- Parameters:
--   m = 16             number of graph connections per layer (default, good balance
--                      of recall vs. memory; increase to 32-64 for higher recall
--                      at the cost of ~2x memory).
--   ef_construction = 64  size of the candidate list during index build. Higher
--                      values improve recall at the cost of slower build time.
--                      64 is the default; 128 is worth testing at larger scales.
--
-- Memory note: HNSW stores the graph in RAM. At 768-dim float32 with m=16,
-- expect ~15–30GB RAM at 5M chunks. This is intentional — at that point you
-- migrate vectors to Qdrant (which uses HNSW with disk-based memmap storage)
-- and drop this index entirely.
create index document_chunks_embedding_idx
  on document_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- IMPORTANT: queries MUST use the <=> operator (cosine distance) to hit this index.
-- Using <-> (L2) or <#> (inner product) will bypass the index and cause a full
-- sequential scan. All application queries should follow this pattern:
--   ORDER BY embedding <=> $1 LIMIT n

-- Supports fast lookup of all chunks belonging to a document, used by the
-- worker when updating or deleting chunks, and by the query layer when
-- reconstructing full document context around a matched chunk.
create index document_chunks_document_id_idx
  on document_chunks(document_id);

-- Supports per-user filtering during vector search. LlamaIndex can pre-filter
-- by user_id before scanning the embedding index, which is important for
-- correctness (users must not see each other's chunks) and for performance
-- (reduces the effective search space per query).
create index document_chunks_user_id_idx
  on document_chunks(user_id);


-- -----------------------------------------------------------------------------
-- Row Level Security: documents
-- -----------------------------------------------------------------------------

-- Enables RLS on the table. Without this, the policies below have no effect.
alter table documents enable row level security;

-- Single policy covering all operations (SELECT, INSERT, UPDATE, DELETE).
-- auth.uid() is the Supabase helper that returns the UUID of the authenticated
-- caller from the JWT. This ensures users can only ever touch their own rows,
-- regardless of what the application layer sends.
create policy "users can only access their own documents"
  on documents
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- -----------------------------------------------------------------------------
-- Row Level Security: document_chunks
-- -----------------------------------------------------------------------------

alter table document_chunks enable row level security;

-- Mirrors the documents policy. The denormalized user_id column makes this
-- enforcement cheap — no join to documents required at query time.
create policy "users can only access their own chunks"
  on document_chunks
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- -----------------------------------------------------------------------------
-- Storage: documents bucket
-- -----------------------------------------------------------------------------

-- Creates a private storage bucket for raw document images.
-- 'public = false' means image URLs are not guessable — they require a signed
-- URL or a valid JWT, consistent with the RLS model on the documents table.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false);

-- Allows authenticated users to upload images only into their own folder.
-- The convention is "documents/<user_id>/<filename>" so (storage.foldername(name))[1]
-- extracts the user_id segment and compares it to the caller's JWT uid.
create policy "users can upload their own images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allows authenticated users to read only their own images using the same
-- folder-prefix convention.
create policy "users can read their own images"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allows authenticated users to delete their own images, e.g. if a document
-- is removed from the app.
create policy "users can delete their own images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
