# Phase 2: Actions UI

Surface LLM-extracted action suggestions to the user after a document is uploaded and processed. This is a proof-of-concept — native integrations (calendar, notifications) are explicitly out of scope. The goal is to make suggested actions visible and dismissible.

## Status

| Part | Description | Status |
|---|---|---|
| Part 0 | Live post-upload view in scan screen | Done |
| Part 1 | Data layer (Document type) | Partially done |
| Part 2 | Card: live processing indicator | Not started |
| Part 3 | Modal: action cards | Not started |

---

## Part 0 — Live post-upload view ✅

**File:** `mobile/app/scan.tsx`

After upload the result screen now shows live status updates instead of static OCR text. Uses Supabase Realtime to receive `documents.status` and `documents.actions_status` changes pushed from the worker.

**States shown:**
- `queued / processing` → spinner + "Processing your document..."
- `indexed` + `analyzing` → spinner + "Finding actions..."
- `indexed` + `ready` + actions → action cards (one per suggestion)
- `indexed` + `ready` + no actions → "No actions needed."
- `indexed` + `actions_status = failed` → quiet grey note
- `status = failed` → error message

**Action cards (POC):** Show type label, title, key detail line. Two buttons — "Do it" and "Not now" — both dismiss the card locally. No PATCH call, no native integration.

**Supporting changes made:**
- `mobile/lib/api.ts` — `UploadResult` now includes `document_id`; added `Action`, `ActionsResponse` types and `fetchActions()` function
- `mobile/lib/realtime.ts` — added `useActionsStatus()` hook and exported `ActionsStatus` type
- `infra/supabase/migrations/20260422000001_realtime_publication.sql` — adds `documents` to the Supabase Realtime publication (was missing; no UPDATEs were being streamed)

---

## Part 1 — Data layer (remaining item)

**File:** `mobile/lib/documents.ts`

Add `actions_status` to the `Document` type. The `GET /documents` API already returns it; the TypeScript type just doesn't include it yet.

```ts
actions_status: 'analyzing' | 'ready' | 'failed' | null;
```

---

## Part 2 — Card: live processing indicator

**File:** `mobile/app/index.tsx` — `DocumentCard` component

**Changes:**
- Wire `useDocumentStatus(doc.id)` into each `DocumentCard` so the status updates live from Realtime instead of only reflecting the initial list fetch
- While `status` is `pending / queued / processing`, overlay an `ActivityIndicator` on the card thumbnail
- When `status` transitions to `indexed` or `failed`, spinner disappears

---

## Part 3 — Modal: action cards

**File:** `mobile/app/index.tsx` — fullscreen modal

**Changes:**
- Add `useActionsStatus(doc.id)` to the modal
- When `actionsStatus` transitions to `ready`, call `fetchActions(doc.id)` and display results
- Extract `ActionCard` from `scan.tsx` into `mobile/components/ActionCard.tsx` so both screens share it

**Modal states (added below OCR text):**

| State | UI |
|---|---|
| `status !== indexed` | "Processing…" (already partially there) |
| `indexed` + `analyzing` or `null` | Small spinner + "Finding actions..." |
| `ready` + actions present | Action cards |
| `ready` + no actions | Nothing |
| `actions_status = failed` | Subtle grey note |

---

## Explicitly out of scope (POC)

- `PATCH /documents/{id}/actions/{action_id}` — no status persistence; dismissed state is local only
- `expo-calendar` — no native calendar integration
- `expo-notifications` — no native notification scheduling
- New screens or routes — everything stays in the existing scan result view and fullscreen modal
