-- Enable Supabase Realtime postgres_changes for the documents table.
-- Without this, UPDATE events on documents never reach subscribed mobile clients,
-- so status and actions_status changes are invisible until a manual refresh.
alter publication supabase_realtime add table documents;
