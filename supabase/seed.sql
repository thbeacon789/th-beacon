-- Seed：全域檢傷規則（db reset 時載入）
-- CI 每日測試失敗（spec §4.1 使用慣例）：預設 P1
-- 服務級規則若要覆蓋此全域規則，priority 需 > 100（數字大者優先）
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P1', array['ci'], '{"errorType": "test_failure"}'::jsonb);
