-- 服務負責人：Discord 使用者 ID（snowflake，17–20 位數字）。通知時以 <@id> tag 負責人。
-- 可空：未設定時通知照發、不 tag。
alter table public.services
  add column owner_discord_id text
  constraint services_owner_discord_id_format check (owner_discord_id ~ '^[0-9]{17,20}$');
