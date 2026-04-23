# Supabase Local Dev Containers

When running `supabase start`, 11 containers spin up. Not all are necessary for this project.

## Essential (load-bearing for the app)

| Container | Image | What it does |
|---|---|---|
| `supabase_db` | postgres:17 | Postgres with pgvector — core DB |
| `supabase_auth` | gotrue | JWT auth — mobile login, RLS depends on this |
| `supabase_rest` | postgrest | Auto-REST API — Supabase client SDK uses this |
| `supabase_realtime` | realtime | WebSocket server — pushes `documents.status` changes to mobile |
| `supabase_storage` | storage-api | Object storage — holds uploaded images before worker processes them |
| `supabase_kong` | kong | API gateway — routes all traffic to the above on a single port (44321) |

## Dev convenience only

| Container | What it does |
|---|---|
| `supabase_studio` | Web dashboard UI (port 44323) — useful for browsing DB/storage, not needed at runtime |
| `supabase_pg_meta` | Postgres metadata API — powers Studio, not used by the app |

## Unused / safe to disable

| Container | What it does | How to disable |
|---|---|---|
| `supabase_analytics` | Logflare log aggregation — Supabase Cloud feature, unused locally | `[analytics] enabled = false` in `config.toml` |
| `supabase_vector` | Log forwarder for analytics only | Drops automatically when analytics is disabled |
| `supabase_inbucket` | Fake SMTP server (port 44324) — only needed for email auth flows | `[inbucket] enabled = false` in `config.toml` |

## Ports (local)

| Port | Service |
|---|---|
| 44321 | Kong (main API gateway — use this) |
| 44322 | Postgres direct |
| 44323 | Studio UI |
| 44324 | Inbucket email UI |
| 44328 | Analytics (Logflare) |
