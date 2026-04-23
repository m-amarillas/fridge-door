-- Dev-only seed: a fixed user so uploads work without auth.
-- This row is referenced by the _DEV_USER_ID constant in api/routers/ingest.py.
-- Remove both when real auth is wired up.
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token, recovery_token,
  email_change_token_new, email_change
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'dev@localhost',
  '', now(), now(), now(),
  '{"provider":"email","providers":["email"]}', '{}',
  false, '', '', '', ''
) ON CONFLICT (id) DO NOTHING;
