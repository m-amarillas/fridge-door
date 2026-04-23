# Mobile

Expo + React Native app. Parents capture school documents with the camera; the app uploads them, displays processing status in real time, and surfaces action suggestions from the LLM.

## Stack
- Expo SDK 54, expo-router (file-based routing), expo-camera
- TypeScript throughout
- Supabase JS client for auth, storage uploads, and Realtime

## Key behaviors
- **Offline capture** — images queue locally in expo-sqlite when offline; expo-task-manager syncs when connectivity returns
- **SHA-256 dedup** — hash computed on device before upload; server returns 409 if already exists
- **Realtime status** — subscribe to `documents.status` via Supabase Realtime instead of polling
- **Realtime actions** — also watch `documents.actions_status`; when it transitions to `ready`, fetch action suggestions via `GET /documents/{id}/actions`
- **Functionality first** — no complex UX yet; get the core capture → search flow working before polish

## Action suggestions (Phase 2 — not yet built)
When `actions_status` arrives as `ready` via Realtime:
1. Call `GET /documents/{id}/actions` on the FastAPI API
2. Render action cards below the document (one card per suggestion)
3. "Do it" → call native integration + `PATCH /documents/{id}/actions/{action_id}` with `status: accepted`
4. "Not now" → `PATCH` with `status: dismissed`

Native integrations for accepted actions:
- `calendar_event` → `expo-calendar` (cross-platform)
- `reminder` → `expo-notifications` (local notification scheduled at `remind_at`)
- `task` → in-app task list (native reminders are iOS-only; avoid `expo-reminders` for now)
- `note` → display only, no native integration needed

## Env vars
All client-side vars must be prefixed `EXPO_PUBLIC_` to be bundled into the app.
```
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
EXPO_PUBLIC_API_BASE_URL
```
Never put `SUPABASE_SECRET_KEY` or any server-side secret in mobile env vars.

## Auth
- Supabase Auth handles JWT issuance
- The JWT is passed as a Bearer token on all API requests to FastAPI
- FastAPI validates the JWT — mobile never talks directly to the worker
