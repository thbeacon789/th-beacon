-- Seed：全域檢傷規則（db reset 時載入）
-- CI 每日測試失敗（spec §4.1 使用慣例）：預設 P1
-- 服務級規則若要覆蓋此全域規則，priority 需 > 100（數字大者優先）
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P1', array['ci'], '{"errorType": "test_failure"}'::jsonb);

-- 服務失聯（health check 失敗）：達頻率門檻才 P0（與 health_failure_threshold 預設 2 對齊，
-- 低於門檻維持預設 P2，避免單次瞬斷即拉滿告警）。服務級規則若要覆蓋，priority 需 > 100
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P0', array['availability'], '{"errorType": "health_check_failed", "minCountInWindow": 2, "windowMinutes": 15}'::jsonb);

-- 心跳逾期：排程工作完全沒回報（workflow 被停用／cron 壞掉）。
-- P1 而非 P0——排程沒跑不等於服務本體死亡（那是 health_check_failed 的 P0）。
-- P1 已達 NOTIFY_MIN_SEVERITY，會發 Discord。
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P1', array['heartbeat'], '{"errorType": "heartbeat_missed"}'::jsonb);

-- 登入白名單（本地開發預設；正式環境由管理員在 Studio 維護 allowed_emails）
insert into public.allowed_emails (email, note)
values ('navibluer@gmail.com', 'dev admin');
