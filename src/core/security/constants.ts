// 資安監控的數值常數（集中於此，不在他處寫死）
export const LOG_SPIKE_RATIO = 5
export const LOG_SPIKE_MIN_EXCESS = 500
export const LOG_BASELINE_MIN_SCANS = 3
export const BASELINE_WINDOW_DAYS = 7
export const CERT_WARN_DAYS = 30
export const CERT_BAD_DAYS = 14
export const STALE_AFTER_HOURS = 30
export const RETENTION_DAYS = 90
export const MAX_SCAN_AGE_HOURS = 2
export const MAX_FINDINGS = 30
// LLM 判讀（ports／updates／logins）發現筆數上限，judge prompt 引用此值
export const JUDGE_MAX_FINDINGS = 15
export const MAX_SUMMARY = 80
export const MAX_TITLE = 120
export const MAX_RECOMMENDATION = 300
export const AUTO_RESOLVE_MISSES_JUDGED = 2
export const AUTO_RESOLVE_MISSES_COMPUTED = 1
export const CHANGES_REOPEN_GAP_DAYS = BASELINE_WINDOW_DAYS + 1
export const RESOLVED_LIST_LIMIT = 100
export const FALLBACK_KEY = '_fallback'
