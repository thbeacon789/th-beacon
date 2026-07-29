-- 最後一次執行的摘要（pass 與 fail 都存）。
-- 動機：回報端送的 summary 原本只在 fail 路徑進 events.metadata，pass 時被丟棄——
-- 而成功摘要（例如「解析成功：<商品名>（1234ms）」）正是效能退化的早期信號，
-- 也能證明測試真的在測東西而非空跑成功。
alter table public.heartbeats add column last_run_summary text;
