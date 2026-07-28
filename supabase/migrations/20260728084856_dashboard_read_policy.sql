-- Dashboard 讀取邊界：
-- issues 開放 authenticated SELECT（Realtime postgres_changes 需要）；
-- services / events / triage_rules / notifications 維持無 policy（deny）——
-- 頁面資料由 server-side service_role 讀取，webhook_secret / discord_webhook_url 不出伺服器（Plan 2 交接）。
create policy "authenticated can read issues"
  on public.issues
  for select
  to authenticated
  using (true);

-- Realtime：把 issues 加進 supabase_realtime publication（若已存在會報錯——以 reset 結果為準）
alter publication supabase_realtime add table public.issues;
