-- =============================================================================
-- Migration: document_actions
-- =============================================================================
-- Adds the action suggestion layer: when the Go worker finishes OCR + indexing
-- it passes the full document text to Claude Sonnet (tool calling) which emits
-- zero or more structured action suggestions. Those suggestions live here.
--
-- Lifecycle: Go worker writes suggested rows → mobile shows cards to parent →
-- parent accepts or dismisses → accepted actions are executed natively (calendar,
-- reminders, etc.) and marked completed.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- actions_status on documents
-- -----------------------------------------------------------------------------

-- Tracks action analysis separately from the indexing pipeline so the document
-- appears in the library (indexed) as soon as embeddings are stored, and action
-- cards arrive a moment later without blocking the primary status flow.
--
-- Values: null (analysis not started), 'analyzing', 'ready', 'failed'
alter table documents
  add column actions_status text;


-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type action_type as enum (
  'calendar_event',  -- add an event to the parent's calendar
  'task',            -- a to-do item the parent needs to complete
  'reminder',        -- time-based or item-based reminder ("bring $5 Friday")
  'note'             -- key info worth surfacing but no explicit deadline
);

create type action_status as enum (
  'suggested',   -- Claude proposed it, awaiting parent decision
  'accepted',    -- parent tapped "Do it"
  'dismissed',   -- parent tapped "Not now"
  'completed'    -- native action executed (calendar event created, etc.)
);


-- -----------------------------------------------------------------------------
-- Table: document_actions
-- -----------------------------------------------------------------------------

create table document_actions (
  id           uuid primary key default gen_random_uuid(),

  -- The source document. Cascade delete removes all actions when a document
  -- is deleted so there are no orphaned suggestion rows.
  document_id  uuid not null references documents(id) on delete cascade,

  -- Denormalized for RLS and query efficiency — avoids joining to documents
  -- when the mobile client fetches actions for a given user.
  user_id      uuid not null references auth.users(id) on delete cascade,

  action_type  action_type not null,

  -- Current state in the suggestion lifecycle.
  status       action_status not null default 'suggested',

  -- Type-specific fields. Shape varies by action_type:
  --   calendar_event: {title, date, time?, notes?, all_day}
  --   task:           {title, due_date?, notes?, priority}
  --   reminder:       {title, message, remind_at?, item?}
  --   note:           {title, content}
  payload      jsonb not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- Trigger: keep updated_at current on document_actions
-- -----------------------------------------------------------------------------

-- Reuses the set_updated_at() function defined in the initial schema migration.
create trigger document_actions_updated_at
  before update on document_actions
  for each row execute procedure set_updated_at();


-- -----------------------------------------------------------------------------
-- Row Level Security: document_actions
-- -----------------------------------------------------------------------------

alter table document_actions enable row level security;

create policy "users can only access their own actions"
  on document_actions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- -----------------------------------------------------------------------------
-- Indexes: document_actions
-- -----------------------------------------------------------------------------

-- Primary lookup: all actions for a specific document (used by GET endpoint
-- and mobile action card display).
create index document_actions_document_id_idx
  on document_actions(document_id);

-- Per-user lookup: all pending actions across all documents (future "inbox" view).
create index document_actions_user_id_idx
  on document_actions(user_id);

-- Filter by status: finding all suggested actions awaiting parent decision.
create index document_actions_status_idx
  on document_actions(status);
