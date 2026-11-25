#!/usr/bin/env bash
# 從 CI e2e 的完整 log 確定性萃取「判讀失敗真因需要的訊號」，stdout 輸出一份小而完整的 signals 檔。
# canonical 在 th-beacon，各 CI repo 於 workflow 執行時 checkout th-beacon 的釘選 commit 使用，不複製。
# 用法：extract-e2e-signals.sh <android|ios> <log-file>...      → signals 寫到 stdout
#
# 為什麼存在：diagnose／ai-fix 送模型的 log 有位元組上限，過去靠「聚焦腳本＋尾段切口」，真因一再被盲切——
#   2026-11-25 Android：logcat-focus 210KB（其中 921 行是崩潰時 ART 印出的 THREAD_STATE 全執行緒 dump），
#     真因 `Error was captured in composition` + CalledFromWrongThreadException（堆疊 82 行，第 66KB 處）被尾段切掉；
#   2026-10-30：App 被殺的行距檔尾 141KB，同樣被切掉。
# 本腳本不靠 tag 白名單，改依「嚴重度＋例外結構」萃取，輸出有硬上限，超量時先丟次要的行、保留每個去重後的例外簽章。
#
# android 模式（輸入為 adb logcat threadtime 格式：第 3 欄 pid、第 5 欄等級；非 logcat 的行只撈 [e2e 標記與 gradle／JUnit 失敗行）：
#   - App／test 進程 pid 取自 `Start proc <pid>:<pkg>(.test)?/`；找不到 Start proc 時退回「所有 E/F 行中含例外結構的區塊」。
#   - App pid 的 E/F/A 行：例外堆疊以區塊處理（起頭為含 Exception／Error／Caused by:／FATAL EXCEPTION 的行）。
#     每段（主例外與各 Caused by）保留前 N 個 frame（預設 12），屬於 App 套件（com.trustnel.）的 frame 不論位置一律保留；
#     連續重複的同一 frame 摺疊為「…（重複 k 次）」；以「例外類別＋根因類別＋第一個 App frame（沒有則前 3 個 frame）」去重，
#     附出現次數與首次／末次時間。THREAD_STATE（thread dump）整個略過，只在統計列計數。
#   - 系統層（任何 pid）：ActivityManager 的 Killing／has died／ANR in／Force finishing、Zygote exited due to signal、
#     lowmemorykiller／lmkd、Application Not Responding；與 App 相關者與其他進程分開，其他進程的次要項先被丟。
#   - 時間軸（任何 pid，完整保留）：TrustnelE2E 標記、TestRunner 的 started／failed／finished。
# ios 模式（輸入為 xcodebuild／xcresult 文字 log，ANSI 色碼先去除）：
#   - 時間軸：Test Case／Test Suite 的 started／passed／failed、[e2e 標記、** TEST FAILED/SUCCEEDED **、Executed N tests。
#   - 錯誤區塊（前 6 行／後 6 行脈絡，崩潰類後 25 行；重疊合併，正規化後相同者去重並計次）：
#     error:、XCTAssert／XCTFail、Fatal error、Terminating app due to uncaught exception、crash、Thread N Crashed、
#     EXC_／SIG 訊號、Assertion failed、Failing tests。
#
# 環境變數（皆選填）：
#   E2E_SIGNALS_MAX_BYTES    硬上限，預設 30000（目標 ≤ 20000：次要區段各有固定小額度，超過上限才再往下砍）
#   E2E_SIGNALS_MAX_FRAMES   每段例外保留的前 N 個 frame，預設 12（例外區段過大時自動降到 8／5／3／1）
#   E2E_SIGNALS_PACKAGE      android 的 App 套件名，預設 com.trustnel.app.debug（Start proc 比對用）
#   E2E_SIGNALS_APP_PREFIX   視為 App frame 的套件前綴，預設 com.trustnel.
# 相容 bash 3.2（macOS）與 bash 5。變數接在中文前一律寫 ${var}。輸入檔讀不到只警告；全部讀不到 exit 1（stdout 無輸出）。
set -uo pipefail
export LC_ALL=C # awk／grep 以位元組處理，輸入含非 UTF-8 也不會炸；最後再以 iconv 清掉被切壞的多位元組字元

PLATFORM="${1:-}"
case "$PLATFORM" in
  android|ios) ;;
  *) echo "usage: extract-e2e-signals.sh <android|ios> <log-file>..." >&2; exit 2 ;;
esac
shift
if [ "$#" -lt 1 ]; then
  echo "usage: extract-e2e-signals.sh <android|ios> <log-file>..." >&2
  exit 2
fi

num_or() { case "$1" in ''|*[!0-9]*) echo "$2" ;; *) echo "$1" ;; esac; }
CAP="$(num_or "${E2E_SIGNALS_MAX_BYTES:-}" 30000)"
[ "$CAP" -ge 2000 ] || CAP=2000
FRAMES="$(num_or "${E2E_SIGNALS_MAX_FRAMES:-}" 12)"
[ "$FRAMES" -ge 1 ] || FRAMES=1
PKG="${E2E_SIGNALS_PACKAGE:-com.trustnel.app.debug}"
APP_PREFIX="${E2E_SIGNALS_APP_PREFIX:-com.trustnel.}"

FILES=()
for f in "$@"; do
  if [ -f "$f" ] && [ -r "$f" ]; then FILES+=("$f"); else echo "extract-e2e-signals: warning: cannot read $f" >&2; fi
done
[ "${#FILES[@]}" -gt 0 ] || { echo "extract-e2e-signals: no readable input" >&2; exit 1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/signals.XXXXXX")" || exit 1
trap 'rm -rf "$W"' EXIT

# ---------------------------------------------------------------------------------------------
# awk 程式：android（單趟，區段檔寫到 $OUT 目錄）
# ---------------------------------------------------------------------------------------------
cat >"$W/android.awk" <<'AWK_EOF'
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function trunc(s) { if (length(s) > MAXLINE) return substr(s, 1, MAXLINE) "…"; return s }
function norm(s) { gsub(/[0-9]+/, "#", s); return s }
function isapp(s) { return index(s, APP) > 0 }
function mentions_app(s,   i) {
  if (index(s, PKG) > 0) return 1
  for (i = 1; i <= npl; i++) if (match(" " s " ", "[^0-9]" PL[i] "[^0-9]")) return 1
  return 0
}

function plain(ts, lvl, tag, msg,   key, j) {
  msg = trim(msg)
  key = tag SUBSEP norm(msg)
  if (key in pidx) { pc[pidx[key]]++; return }
  if (nplain >= MAXPLAIN) { plain_dropped++; return }
  j = ++nplain
  pidx[key] = j; pc[j] = 1
  ptxt[j] = ts " " lvl " " tag ": " trunc(msg)
}
function sysev(isapp_ev, ts, pid, tag, msg,   key, j) {
  key = tag SUBSEP norm(msg)
  if (isapp_ev) {
    if (key in saidx) { sac[saidx[key]]++; return }
    j = ++nsa; saidx[key] = j; sac[j] = 1; satxt[j] = ts " " pid " " tag ": " trunc(trim(msg))
  } else {
    if (key in soidx) { soc[soidx[key]]++; return }
    if (nso >= MAXSO) { so_dropped++; return }
    j = ++nso; soidx[key] = j; soc[j] = 1; sotxt[j] = ts " " pid " " tag ": " trunc(trim(msg))
  }
}

function additem(id, type, text,   k) {
  k = ++b_n[id]
  it[id, k] = text; ty[id, k] = type
  if (type == "F") b_nf[id]++
  else if (type == "H") { b_nh[id]++; if (text ~ CLASSRE) b_cls[id] = 1 }
}
function newblock(key, ts, lvl, pid, tid, tag, msg,   id) {
  id = ++nblk
  b_ts[id] = ts; b_lvl[id] = lvl; b_pid[id] = pid; b_tid[id] = tid; b_tag[id] = tag; b_nr[id] = NR
  b_n[id] = 0; b_nf[id] = 0; b_nh[id] = 0; b_cls[id] = 0
  open[key] = id
  additem(id, "H", msg)
  return id
}
function is_cont(id, msg) {
  if (msg ~ /^[ \t]+at /) return 1
  if (msg ~ /^Caused by:/ || msg ~ /^[ \t]+Suppressed:/) return 1
  if (msg ~ /^[ \t]+\.\.\. [0-9]+ (more|common frames omitted)/) return 1
  # 尚未出現 frame、且還沒看到例外類別的區塊：後續的類別行與 Process: 行屬於同一區塊（FATAL EXCEPTION／Error was captured 開頭）
  if (b_nf[id] == 0 && !b_cls[id] && b_nh[id] < 4 && (msg ~ CLASSRE || msg ~ /^Process:/)) return 1
  return 0
}
function addcont(id, msg) {
  if (msg ~ /^[ \t]+at /) additem(id, "F", msg)
  else if (msg ~ /^[ \t]+\.\.\. [0-9]+ /) additem(id, "M", msg)
  else additem(id, "H", msg)
}

# 把一段 frame 串（fe／fc）輸出到 rout：前 N 個＋所有 App frame，被略過的以一行註記
function flush_seg(   j, kept, skipped, line) {
  kept = 0; skipped = 0
  for (j = 1; j <= nfe; j++) {
    if (kept < N || isapp(fe[j])) {
      if (skipped > 0) { rout = rout "    … 省略 " skipped " 個 frame\n"; skipped = 0 }
      line = trunc(trim(fe[j]))
      if (fc[j] > 1) line = line "  …（重複 " fc[j] " 次）"
      rout = rout "    " line "\n"
      kept++
    } else skipped += fc[j]
  }
  if (skipped > 0) rout = rout "    … 省略 " skipped " 個 frame\n"
  nfe = 0
}
function render(id,   k, first) {
  rout = ""; nfe = 0; first = 1
  for (k = 1; k <= b_n[id]; k++) {
    if (ty[id, k] == "F") {
      if (nfe > 0 && fe[nfe] == it[id, k]) fc[nfe]++
      else { nfe++; fe[nfe] = it[id, k]; fc[nfe] = 1 }
    } else {
      flush_seg()
      rout = rout "  " trunc(trim(it[id, k])) "\n"
    }
  }
  flush_seg()
  return rout
}
function closeblock(id,   k, txt, c1, last_caused, croot, fa, f3, nf3, sig, i) {
  c1 = ""; last_caused = ""; fa = ""; f3 = ""; nf3 = 0
  for (k = 1; k <= b_n[id]; k++) {
    txt = it[id, k]
    if (ty[id, k] == "H") {
      if (match(txt, CLASSRE)) {
        if (c1 == "") c1 = substr(txt, RSTART, RLENGTH)
        if (txt ~ /^Caused by:/) last_caused = substr(txt, RSTART, RLENGTH)
      }
    } else if (ty[id, k] == "F") {
      if (fa == "" && isapp(txt)) fa = trim(txt)
      if (nf3 < 3) { f3 = f3 "|" trim(txt); nf3++ }
    }
  }
  croot = (last_caused != "" ? last_caused : c1)
  if (c1 == "" && b_nf[id] == 0) {
    # 沒有例外結構的單行（例如訊息裡剛好有 Error 字樣）：退化成一般 E/F 行；沒有 pid 資訊的退回模式則丟棄
    if (HAVEPIDS) plain(b_ts[id], b_lvl[id], b_tag[id], it[id, 1])
  } else {
    if (b_nf[id] == 0) sig = c1 "|" croot "|" norm(substr(it[id, 1], 1, 100))
    else sig = c1 "|" croot "|" (fa != "" ? fa : f3)
    if (sig in sidx) {
      i = sidx[sig]; scnt[i]++
      if (b_nr[id] < snr[i]) { snr[i] = b_nr[id]; sfirst[i] = b_ts[id] }
      if (b_nr[id] > slnr[i]) { slnr[i] = b_nr[id]; slast[i] = b_ts[id] }
    }
    else if (nsig < MAXSIG) {
      i = ++nsig; sidx[sig] = i; scnt[i] = 1; sfirst[i] = b_ts[id]; slast[i] = b_ts[id]; snr[i] = b_nr[id]; slnr[i] = b_nr[id]
      smeta[i] = "pid=" b_pid[id] " tid=" b_tid[id] " " b_lvl[id] "/" b_tag[id]
      stxt[i] = render(id)
    } else sig_dropped++
  }
  for (k = 1; k <= b_n[id]; k++) { delete it[id, k]; delete ty[id, k] }
  delete b_n[id]
}
function closeall(   key) {
  for (key in open) { closeblock(open[key]); delete open[key] }
}

BEGIN {
  CLASSRE = "[A-Za-z_$][A-Za-z0-9_.$]*(Exception|Error)"
  n = split(pids, pa, / +/)
  for (i = 1; i <= n; i++) if (pa[i] != "") { P[pa[i]] = 1; PL[++npl] = pa[i] }
  HAVEPIDS = (npl > 0)
  APP = appprefix; PKG = pkg; N = frames + 0; MAXLINE = 400
  MAXSIG = 300; MAXPLAIN = 300; MAXSO = 60
}
FNR == 1 && NR > 1 { closeall() }
{
  line = $0
  if (!match(line, /^[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9][0-9] +[0-9]+ +[0-9]+ [VDIWEFA] /)) {
    # 非 logcat 行（例如 e2e.log、JUnit XML）：只撈段落標記與 gradle／JUnit 失敗行
    if (line ~ /^\[e2e/ || line ~ /^> Task .* FAILED/ || line ~ /^FAILURE: / || line ~ /There were failing tests/ || \
        line ~ /BUILD (FAILED|SUCCESSFUL)/ || line ~ /<(failure|error)[ >]/ || line ~ /<testsuite / || line ~ /tests completed/) {
      if (nrn < 120) { rn[++nrn] = trunc(trim(line)) } else rn_dropped++
    }
    next
  }
  ts = $1 " " $2; pid = $3; tid = $4; lvl = $5
  rest = substr(line, RLENGTH + 1)
  p = index(rest, ": ")
  if (p > 0) { tag = substr(rest, 1, p - 1); msg = substr(rest, p + 2) } else { tag = rest; msg = ""; sub(/:$/, "", tag) }
  sub(/^ +/, "", tag); sub(/ +$/, "", tag)
  if (tag == "THREAD_STATE") { thread_state_lines++; next }
  nlog++
  key = pid "/" tid "/" tag
  if (key in open) {
    id = open[key]
    if (is_cont(id, msg)) { addcont(id, msg); next }
    closeblock(id); delete open[key]
  }
  # 時間軸：完整保留
  if (tag == "TrustnelE2E" || (tag == "TestRunner" && msg ~ /^(run )?(started|failed|finished)/)) {
    tl[++ntl] = ts " " pid " " tag ": " trunc(trim(msg))
    next
  }
  # 系統層事件
  issys = 0
  if (tag == "ActivityManager" && (msg ~ /^Killing / || msg ~ /^Process .* has died/ || msg ~ /ANR in / || msg ~ /^Force finishing/)) issys = 1
  else if (tag == "Zygote" && msg ~ /exited due to signal/) issys = 1
  else if ((tag == "lowmemorykiller" || tag == "lmkd") && msg ~ /^Kill|Killing|[Kk]illed process|kill_one|low on memory/) issys = 1
  else if (msg ~ /Application Not Responding/) issys = 1
  else if (tag == "AndroidRuntime" && !(pid in P) && (msg ~ /FATAL EXCEPTION/ || msg ~ /^Process:/)) issys = 1
  if (issys) { sysev(((pid in P) || mentions_app(msg)), ts, pid, tag, msg); next }
  # App 進程的 E/F/A
  if ((lvl == "E" || lvl == "F" || lvl == "A") && (!HAVEPIDS || (pid in P))) {
    nerr++
    if (msg !~ /^[ \t]+at / && (msg ~ /Exception|Error|Caused by:|FATAL EXCEPTION/)) newblock(key, ts, lvl, pid, tid, tag, msg)
    else if (HAVEPIDS) plain(ts, lvl, tag, msg)
  }
}
END {
  closeall()
  # 例外簽章依首次出現順序輸出
  for (i = 1; i <= nsig; i++) ord[i] = i
  for (i = 2; i <= nsig; i++) { v = ord[i]; j = i - 1; while (j >= 1 && snr[ord[j]] > snr[v]) { ord[j + 1] = ord[j]; j-- } ord[j + 1] = v }
  for (q = 1; q <= nsig; q++) {
    i = ord[q]
    printf "[E%d] ×%d 首次 %s", q, scnt[i], sfirst[i] > (OUT "/exc.txt")
    if (scnt[i] > 1) printf " 末次 %s", slast[i] > (OUT "/exc.txt")
    printf " %s\n%s\n", smeta[i], stxt[i] > (OUT "/exc.txt")
  }
  if (sig_dropped > 0) printf "（另有 %d 個簽章因數量上限未列出）\n", sig_dropped > (OUT "/exc.txt")
  close(OUT "/exc.txt")
  for (i = 1; i <= ntl; i++) print tl[i] > (OUT "/tl.txt")
  close(OUT "/tl.txt")
  for (i = 1; i <= nsa; i++) print (sac[i] > 1 ? "×" sac[i] " " : "") satxt[i] > (OUT "/sa.txt")
  close(OUT "/sa.txt")
  for (i = 1; i <= nplain; i++) print (pc[i] > 1 ? "×" pc[i] " " : "") ptxt[i] > (OUT "/pl.txt")
  if (plain_dropped > 0) printf "（另有 %d 種 E/F 行因數量上限未列出）\n", plain_dropped > (OUT "/pl.txt")
  close(OUT "/pl.txt")
  for (i = 1; i <= nso; i++) print (soc[i] > 1 ? "×" soc[i] " " : "") sotxt[i] > (OUT "/so.txt")
  if (so_dropped > 0) printf "（另有 %d 種其他進程事件未列出）\n", so_dropped > (OUT "/so.txt")
  close(OUT "/so.txt")
  for (i = 1; i <= nrn; i++) print rn[i] > (OUT "/rn.txt")
  if (rn_dropped > 0) printf "（另有 %d 行未列出）\n", rn_dropped > (OUT "/rn.txt")
  close(OUT "/rn.txt")
  printf "logcat 行數=%d；App E/F/A 行=%d；例外簽章=%d；略過全執行緒 dump 行=%d\n", nlog, nerr, nsig, thread_state_lines + 0 > (OUT "/stats.txt")
  close(OUT "/stats.txt")
}
AWK_EOF

# ---------------------------------------------------------------------------------------------
# awk 程式：ios
# ---------------------------------------------------------------------------------------------
cat >"$W/ios.awk" <<'AWK_EOF'
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function trunc(s) { if (length(s) > MAXLINE) return substr(s, 1, MAXLINE) "…"; return s }
function norm(s) { gsub(/0x[0-9a-fA-F]+/, "0x#", s); gsub(/[0-9]+/, "#", s); return s }
function istl(s) {
  return (s ~ /^\[e2e/ || s ~ /Test (Case|Suite) .*(started|passed|failed)/ || s ~ /^(◇|✔|✘) / || \
          s ~ /\*\* TEST (FAILED|SUCCEEDED) \*\*/ || s ~ /Executed [0-9]+ tests?/ || s ~ /Testing failed/)
}
function ishit(s) {
  return (s ~ /error:|: error/ || s ~ /XCTAssert|XCTFail|XCTestCase.*fail/ || s ~ /Fatal error/ || \
          s ~ /uncaught exception/ || s ~ /\*\*\* Terminating/ || s ~ /Thread [0-9]+ Crashed|Crashed Thread/ || \
          s ~ /EXC_(BAD|CRASH|BREAKPOINT|ARITHMETIC)|SIGABRT|SIGSEGV|SIGILL|SIGTRAP/ || s ~ /[Cc]rash/ || \
          s ~ /Assertion failed|Precondition failed/ || s ~ /Failing tests|Test Case .* failed/ || s ~ / failed - /)
}
function iscrash(s) {
  return (s ~ /Thread [0-9]+ Crashed|Crashed Thread|uncaught exception|\*\*\* Terminating|Fatal error|EXC_|SIGABRT|SIGSEGV/)
}
function finalize(   sig, i) {
  if (!cur_open) return
  sig = norm(cur_sig)
  if (sig in sidx) { scnt[sidx[sig]]++ }
  else if (nsig < MAXSIG) {
    i = ++nsig; sidx[sig] = i; scnt[i] = 1; snr[i] = cur_nr; stxt[i] = cur_txt
  } else dropped++
  cur_open = 0; cur_txt = ""; cur_n = 0; after_left = 0
}
function addline(prefix, text) { if (cur_n < MAXBLK) { cur_txt = cur_txt prefix text "\n"; cur_n++ } }
BEGIN { MAXLINE = 300; MAXSIG = 150; BEFORE = 6; AFTER = 6; CRASH_AFTER = 25; MAXBLK = 70; RING = BEFORE + 1; last_end = 0 }
{
  line = trunc($0)
  nlog++
  if (istl($0)) { tl[++ntl] = line }
  if (ishit($0)) {
    nhit++
    if (!cur_open) {
      cur_open = 1; cur_nr = NR; cur_sig = $0; cur_txt = ""; cur_n = 0
      for (i = NR - BEFORE; i < NR; i++) if (i >= 1 && i > last_end) addline("  ", ring[i % RING])
    }
    a = iscrash($0) ? CRASH_AFTER : AFTER
    if (a > after_left) after_left = a
    addline("> ", line)
    last_end = NR
  } else if (cur_open) {
    addline("  ", line); after_left--; last_end = NR
    if (after_left <= 0) finalize()
  }
  ring[NR % RING] = line
}
END {
  finalize()
  for (i = 1; i <= nsig; i++) {
    printf "[B%d] ×%d 起於第 %d 行\n%s\n", i, scnt[i], snr[i], stxt[i] > (OUT "/exc.txt")
  }
  if (dropped > 0) printf "（另有 %d 個錯誤區塊因數量上限未列出）\n", dropped > (OUT "/exc.txt")
  close(OUT "/exc.txt")
  for (i = 1; i <= ntl; i++) print tl[i] > (OUT "/tl.txt")
  close(OUT "/tl.txt")
  printf "log 行數=%d；命中錯誤行=%d；錯誤區塊（去重後）=%d\n", nlog, nhit, nsig > (OUT "/stats.txt")
  close(OUT "/stats.txt")
}
AWK_EOF

# ---------------------------------------------------------------------------------------------
# 萃取
# ---------------------------------------------------------------------------------------------
OUT="$W/sec"
mkdir -p "$OUT"
: >"$OUT/exc.txt"; : >"$OUT/tl.txt"; : >"$OUT/sa.txt"; : >"$OUT/pl.txt"; : >"$OUT/so.txt"; : >"$OUT/rn.txt"; : >"$OUT/stats.txt"

PIDS=""
if [ "$PLATFORM" = "android" ]; then
  PKG_RE="$(printf '%s' "$PKG" | sed 's/[][\.*^$()+?{|]/\\&/g')"
  PIDS="$(cat "${FILES[@]}" 2>/dev/null | grep -aoE "Start proc [0-9]+:${PKG_RE}(\.test)?/" \
    | sed -E 's/^Start proc ([0-9]+):.*/\1/' | sort -un | tr '\n' ' ')"
fi

run_extract() { # $1=frames
  if [ "$PLATFORM" = "android" ]; then
    awk -v pids="$PIDS" -v pkg="$PKG" -v appprefix="$APP_PREFIX" -v frames="$1" -v OUT="$OUT" -f "$W/android.awk" "${FILES[@]}"
  else
    for f in "${FILES[@]}"; do
      perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' "$f"
    done | awk -v OUT="$OUT" -f "$W/ios.awk"
  fi
}

size_of() { wc -c <"$1" | tr -d ' '; }
EXC_BUDGET=$((CAP * 60 / 100))
FR="$FRAMES"
while :; do
  run_extract "$FR" || { echo "extract-e2e-signals: awk failed" >&2; exit 1; }
  [ "$PLATFORM" = "ios" ] && break
  [ "$(size_of "$OUT/exc.txt")" -le "$EXC_BUDGET" ] && break
  if [ "$FR" -gt 8 ]; then FR=8
  elif [ "$FR" -gt 5 ]; then FR=5
  elif [ "$FR" -gt 3 ]; then FR=3
  elif [ "$FR" -gt 1 ]; then FR=1
  else break; fi
done

# ---------------------------------------------------------------------------------------------
# 預算：先給次要區段固定小額度（使常態輸出 ≤ 20KB），超過硬上限再依序往下砍
# ---------------------------------------------------------------------------------------------
# $1=檔 $2=上限 bytes：只留開頭（整行），註記省略了多少行
fit_head() {
  local f="$1" max="$2" sz
  sz="$(size_of "$f")"
  [ "$sz" -gt "$max" ] || return 0
  [ "$max" -gt 0 ] || { : >"$f"; return 0; }
  local total kept
  total="$(wc -l <"$f" | tr -d ' ')"
  head -c "$max" "$f" | sed '$d' >"$f.fit"
  kept="$(wc -l <"$f.fit" | tr -d ' ')"
  printf '…（省略 %d 行／%d bytes：超過本區段額度）\n' "$((total - kept))" "$((sz - $(size_of "$f.fit")))" >>"$f.fit"
  mv "$f.fit" "$f"
}
# $1=檔 $2=上限：保留頭 40%／尾 60%，中間省略（時間軸用：開頭的環境與最後的失敗都要看得到）
fit_headtail() {
  local f="$1" max="$2" sz hb tb total
  sz="$(size_of "$f")"
  [ "$sz" -gt "$max" ] || return 0
  total="$(wc -l <"$f" | tr -d ' ')"
  hb=$((max * 4 / 10)); tb=$((max - hb - 80))
  [ "$tb" -gt 0 ] || tb=0
  {
    head -c "$hb" "$f" | sed '$d'
    printf '…（中間省略若干行：時間軸共 %d 行／%d bytes，超過本區段額度）…\n' "$total" "$sz"
    tail -c "$tb" "$f" | sed '1d'
  } >"$f.fit"
  mv "$f.fit" "$f"
}
# $1=檔 $2=上限：以空行分段（每段一個簽章／區塊），只留前面完整的段落
fit_paras() {
  local f="$1" max="$2" sz
  sz="$(size_of "$f")"
  [ "$sz" -gt "$max" ] || return 0
  awk -v max="$max" 'BEGIN { RS = ""; ORS = "\n\n" } { if (used + length($0) + 2 > max) { skipped++; next } print; used += length($0) + 2 }
    END { if (skipped > 0) printf "…（省略 %d 個簽章／區塊：超過上限，優先保留前面較早出現者）\n", skipped }' "$f" >"$f.fit"
  mv "$f.fit" "$f"
}

# 次要區段的固定額度（常態輸出的目標 ≤ 20KB）
fit_head "$OUT/so.txt" 2500
fit_head "$OUT/pl.txt" 4000
fit_head "$OUT/rn.txt" 2500
fit_head "$OUT/sa.txt" 3000

# ---------------------------------------------------------------------------------------------
# 組裝
# ---------------------------------------------------------------------------------------------
if [ "$PLATFORM" = "android" ]; then
  T_EXC="1. 例外簽章（App 進程 E/F/A 的例外堆疊，依「例外類別＋根因＋第一個 App frame」去重；真因常早於最後的崩潰）"
  T_TL="2. 測試時間軸（TrustnelE2E 標記與 TestRunner 起訖，完整保留）"
  T_SA="3. 系統層事件：與 App 相關（殺進程／ANR／Zygote 訊號／LMK）"
  T_PL="4. App 進程其他 E/F/A 行（去重，×N 為出現次數）"
  T_SO="5. 系統層事件：其他進程（次要，額度吃緊時最先被丟）"
  T_RN="6. 非 logcat 輸入的段落標記與 gradle／JUnit 失敗行"
else
  T_EXC="1. 錯誤／崩潰區塊（> 為命中行，前後為脈絡；正規化後相同者去重，×N 為出現次數）"
  T_TL="2. 測試時間軸（Test Case／Suite 起訖、[e2e 標記、測試總結）"
  T_SA=""; T_PL=""; T_SO=""; T_RN=""
fi

emit() { # $1=標題 $2=檔 $3=空檔時是否仍輸出（1 輸出「（無）」）
  if [ -s "$2" ]; then printf '\n## %s\n' "$1"; cat "$2"
  elif [ "$3" = "1" ]; then printf '\n## %s\n（無）\n' "$1"; fi
}

build_out() {
  {
    echo "# E2E 失敗訊號萃取（signals）"
    echo "這份檔案是 scripts/extract-e2e-signals.sh 從完整 log 以確定性規則萃取出來的（不是模型產出、不是尾段切片），"
    echo "依嚴重度與例外結構挑行，不靠 tag 白名單；它是判讀失敗的最可信依據。真因可能比最後的崩潰早很多（例如被吞掉的 captured error），請從頭看。"
    echo "平台：${PLATFORM}；來源檔：$(for f in "${FILES[@]}"; do printf '%s ' "$(basename "$f")"; done)"
    if [ "$PLATFORM" = "android" ]; then
      echo "App 套件：${PKG}；App/test pid：${PIDS:-（找不到 Start proc，退回「所有 E/F 行中含例外結構的區塊」）}；App frame 前綴：${APP_PREFIX}"
      echo "例外保留規則：每段前 ${FR} 個 frame＋所有 ${APP_PREFIX} frame；連續重複 frame 摺疊；崩潰時 ART 印出的全執行緒 dump 不收。"
    fi
    echo "統計：$(cat "$OUT/stats.txt")"
    emit "$T_EXC" "$OUT/exc.txt" 1
    emit "$T_TL" "$OUT/tl.txt" 1
    if [ "$PLATFORM" = "android" ]; then
      emit "$T_SA" "$OUT/sa.txt" 0
      emit "$T_PL" "$OUT/pl.txt" 0
      emit "$T_SO" "$OUT/so.txt" 0
      emit "$T_RN" "$OUT/rn.txt" 0
    fi
  } >"$W/out.txt"
}

build_out
# 超過硬上限：依「次要 → 重要」逐區段往下砍，每步重組後重新量
STEP=0
while [ "$(size_of "$W/out.txt")" -gt "$CAP" ] && [ "$STEP" -lt 8 ]; do
  STEP=$((STEP + 1))
  case "$STEP" in
    1) printf '…（其他進程事件因上限整段省略）\n' >"$OUT/so.txt" ;;
    2) fit_head "$OUT/pl.txt" 1500 ;;
    3) fit_head "$OUT/rn.txt" 1000; fit_head "$OUT/sa.txt" 1500 ;;
    4) fit_headtail "$OUT/tl.txt" 6000 ;;
    5) fit_head "$OUT/pl.txt" 500; fit_head "$OUT/sa.txt" 800 ;;
    6) fit_headtail "$OUT/tl.txt" 3500 ;;
    7) fit_paras "$OUT/exc.txt" $((CAP * 70 / 100)) ;;
    8) fit_paras "$OUT/exc.txt" $((CAP * 50 / 100)) ;;
  esac
  build_out
done
# 最後防線：仍超過就硬切（不應發生；保證輸出不超過上限）
if [ "$(size_of "$W/out.txt")" -gt "$CAP" ]; then
  head -c "$((CAP - 120))" "$W/out.txt" | sed '$d' >"$W/out.cut"
  printf '…（輸出超過上限 %d bytes，後段被硬切）\n' "$CAP" >>"$W/out.cut"
  mv "$W/out.cut" "$W/out.txt"
fi
iconv -c -f utf-8 -t utf-8 "$W/out.txt" 2>/dev/null || cat "$W/out.txt"
