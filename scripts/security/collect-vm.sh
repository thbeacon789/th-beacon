#!/usr/bin/env bash
# th-beacon 資安監控：VM 唯讀收集腳本
#
# 【重要】這是唯讀收集腳本，會在正式環境的 Ubuntu 伺服器上以 root 執行。
# 修改本檔前，請確認仍符合唯讀要求：
#   - 不建立／修改／刪除任何檔案（不用暫存檔；導向只允許 /dev/null 與 2>&1）
#   - 不安裝套件、不重啟或 reload 服務、不改任何設定
#   - 不對檔案內容或指令輸出做 eval／source／bash -c；變數展開一律加雙引號
#   - 不輸出秘密（完整 cron 指令列、shadow、私鑰、環境變數值、authorized_keys 金鑰本體）
#
# 輸出：stdout 以分段文字輸出，每段以 "@@BEACON:<nonce>:<name>@@" 單獨一行開頭，
#       格式契約由 src/core/security/collect/vm-dump.ts 的 parseVmDump 決定。
#
# 環境變數：
#   BEACON_NONCE            必填，[a-f0-9]{32}；不符即 exit 2
#   BEACON_LOG_SOURCES_B64  選填，base64 文字；解碼後每行 name<TAB>type<TAB>target，type 為 file 或 journal
#   BEACON_ROOT             僅供測試：讀取的絕對路徑前綴。正式執行時必須為空字串（未設定）
#
# 用到的指令（全部唯讀）：
#   ss, /usr/lib/update-notifier/apt-check, apt list --upgradable, cat, apt-config dump,
#   sshd -T, journalctl, getent, ssh-keygen -lf, systemctl list-timers / list-unit-files / cat,
#   sha256sum, date -u +%s, base64 -d, 以及文字工具 awk grep cut sort uniq tail printf
#
# 相容性：目標為 Ubuntu 22.04/24.04（bash 5、GNU coreutils），但避免 bash 4+ 專屬語法，
#         日期換算全部用 awk 自行計算（不用 date -d），測試可在 macOS（bash 3.2）執行。

set -u
export LC_ALL=C

R="${BEACON_ROOT:-}"
NONCE="${BEACON_NONCE:-}"
nonce_re='^[a-f0-9]{32}$'
if ! [[ $NONCE =~ $nonce_re ]]; then
  echo "BEACON_NONCE 格式不符（需為 32 碼小寫十六進位）" >&2
  exit 2
fi

sec() { printf '@@BEACON:%s:%s@@\n' "$NONCE" "$1"; }

# 輸出一個區段；經 awk 保證結尾有換行，避免下一個標記黏在上一行尾端
section() {
  sec "$1"
  shift
  "$@" 2>/dev/null < /dev/null | awk '{ print }'
}

s_listeners() { ss -H -tulnp; }

s_apt_check() {
  if [ -x "$R/usr/lib/update-notifier/apt-check" ]; then
    "$R/usr/lib/update-notifier/apt-check" 2>&1
  fi
}

s_apt_upgradable() { apt list --upgradable 2>/dev/null; }

s_reboot_required() {
  if [ -f "$R/var/run/reboot-required" ]; then echo yes; else echo no; fi
}

s_os_release() { cat "$R/etc/os-release"; }

s_auto_updates() { apt-config dump APT::Periodic::Unattended-Upgrade; }

s_sshd() { sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin) '; }

s_auth() {
  journalctl -u ssh -u sshd --since '24 hours ago' --no-pager -o short-iso 2>/dev/null | grep -E 'Failed password|Invalid user|Accepted ' | tail -n 20000
}

s_users() {
  getent passwd | awk -F: '$7 !~ /(nologin|false)$/ { print $1 }'
}

s_admins() {
  {
    getent group sudo admin | awk -F: '{ n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] != "") print m[i] }'
    local f
    for f in "$R/etc/sudoers" "$R"/etc/sudoers.d/*; do
      if [ -f "$f" ] && [ -r "$f" ]; then
        awk '
          { sub(/^[ \t]+/, "") }
          $0 == "" { next }
          /^[#%@]/ { next }
          /^(Defaults|User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias)([ \t:]|$)/ { next }
          $1 ~ /^[A-Za-z0-9_.@-]+$/ { print $1 }
        ' "$f"
      fi
    done
  } | awk '!seen[$0]++'
}

s_ssh_keys() {
  local user home f line fp
  local user_re='^[A-Za-z0-9_.-]+$'
  local fp_re='^[A-Za-z0-9]+:[A-Za-z0-9+/=]+$'
  while IFS=: read -r user _ _ _ _ home _; do
    [[ $user =~ $user_re ]] || continue
    [ -n "$home" ] || continue
    f="$R$home/.ssh/authorized_keys"
    [ -f "$f" ] && [ -r "$f" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        '' | '#'*) continue ;;
      esac
      fp=$(printf '%s\n' "$line" | ssh-keygen -lf /dev/stdin 2>/dev/null | awk '{ print $2; exit }')
      if [[ $fp =~ $fp_re ]]; then
        printf '%s\t%s\n' "$user" "$fp"
      fi
    done < "$f"
  done < <(getent passwd)
}

# 單一 crontab 檔：$1=檔案 $2=是否為系統格式（1 有使用者欄／0 無）
# awk 只輸出「schedule TAB executable TAB 整行」給內部迴圈雜湊，整行不會出現在 stdout
sched_file() {
  [ -f "$1" ] && [ -r "$1" ] || return 0
  local loc="${1#"$R"}" sch exe line hash
  awk -v sys="$2" '
    {
      sub(/^[ \t]+/, ""); sub(/[ \t\r]+$/, "")
      if ($0 == "" || $0 ~ /^#/) next
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) next
      if ($1 ~ /^@/) { sch = $1; i = 2 } else { sch = $1 " " $2 " " $3 " " $4 " " $5; i = 6 }
      if (sys == "1") i++
      if (NF < i) next
      print sch "\t" $i "\t" $0
    }
  ' "$1" | while IFS=$'\t' read -r sch exe line; do
    hash=$(printf '%s' "$line" | sha256sum | awk '{ print $1 }')
    printf '%s\t%s\t%s\t%s\n' "$loc" "$sch" "$exe" "$hash"
  done
}

s_scheduled() {
  local f unit hash
  local unit_re='^[A-Za-z0-9_.@:-]+$'
  sched_file "$R/etc/crontab" 1
  for f in "$R"/etc/cron.d/*; do sched_file "$f" 1; done
  for f in "$R"/var/spool/cron/crontabs/*; do sched_file "$f" 0; done
  systemctl list-timers --all --no-legend 2>/dev/null \
    | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /\.timer$/) { if (!seen[$i]++) print $i; break } }' \
    | while read -r unit; do
      [[ $unit =~ $unit_re ]] || continue
      hash=$(systemctl cat "$unit" 2>/dev/null < /dev/null | sha256sum | awk '{ print $1 }')
      printf '%s\t\t\t%s\n' "$unit" "$hash"
    done
}

s_services() {
  systemctl list-unit-files --type=service --state=enabled --no-legend | awk '{ print $1 }'
}

# journal 型：--utc 直接輸出 UTC，取每行前 13 字元（YYYY-MM-DDTHH）計數
log_journal() {
  local out
  out=$(journalctl --utc -u "$1" --since '24 hours ago' --no-pager -o short-iso 2>/dev/null) || { echo ERROR; return 0; }
  printf '%s\n' "$out" \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}' \
    | cut -c1-13 | sort | uniq -c \
    | awk '{ printf "%s:00:00Z\t%s\n", $2, $1 }'
}

# file 型：讀 target 與 target.1，解析 [18/Nov/2026:02:13:44 +0000]，換算 UTC 整點，只留過去 24 小時
log_file() {
  local t="$R$1" now
  if ! { [ -f "$t" ] && [ -r "$t" ]; }; then echo ERROR; return 0; fi
  now=$(date -u +%s 2>/dev/null)
  local now_re='^[0-9]+$'
  if ! [[ $now =~ $now_re ]]; then echo ERROR; return 0; fi
  set -- "$t"
  if [ -f "$t.1" ] && [ -r "$t.1" ]; then set -- "$@" "$t.1"; fi
  awk -v now="$now" '
    function dfc(y, m, d,   era, yoe, doy, doe, mp) {
      if (m <= 2) y -= 1
      era = int(y / 400); yoe = y - era * 400
      mp = (2 < m) ? m - 3 : m + 9
      doy = int((153 * mp + 2) / 5) + d - 1
      doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
      return era * 146097 + doe - 719468
    }
    BEGIN {
      split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ")
      for (i = 1; i <= 12; i++) mon[mn[i]] = i
      lo = now - 86400
    }
    {
      if (match($0, /\[[0-9][0-9]\/[A-Za-z][A-Za-z][A-Za-z]\/[0-9][0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]:[0-9][0-9] [+-][0-9][0-9][0-9][0-9]\]/) == 0) next
      t = substr($0, RSTART + 1, RLENGTH - 2)
      m = mon[substr(t, 4, 3)]
      if (m == "") next
      off = (substr(t, 23, 2) + 0) * 3600 + (substr(t, 25, 2) + 0) * 60
      if (substr(t, 22, 1) == "-") off = -off
      e = dfc(substr(t, 8, 4) + 0, m, substr(t, 1, 2) + 0) * 86400 + (substr(t, 13, 2) + 0) * 3600 + (substr(t, 16, 2) + 0) * 60 + (substr(t, 19, 2) + 0) - off
      if (e < lo || now < e) next
      c[int(e / 3600) * 3600]++
    }
    END { for (h in c) printf "%d\t%d\n", h, c[h] }
  ' "$@" | sort -n | awk '
    function cfd(z,   era, doe, yoe, y, doy, mp, d, m) {
      z += 719468; era = int(z / 146097); doe = z - era * 146097
      yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
      y = yoe + era * 400; doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
      mp = int((5 * doy + 2) / 153); d = doy - int((153 * mp + 2) / 5) + 1
      m = (mp < 10) ? mp + 3 : mp - 9
      if (m <= 2) y++
      CY = y; CM = m; CD = d
    }
    {
      days = int($1 / 86400); cfd(days); sod = $1 - days * 86400
      printf "%04d-%02d-%02dT%02d:00:00Z\t%d\n", CY, CM, CD, int(sod / 3600), $2
    }
  '
}

section listeners s_listeners
section apt_check s_apt_check
section apt_upgradable s_apt_upgradable
section reboot_required s_reboot_required
section os_release s_os_release
section auto_updates s_auto_updates
section sshd s_sshd
section auth s_auth
section users s_users
section admins s_admins
section ssh_keys s_ssh_keys
section scheduled s_scheduled
section services s_services

# log:<name> 區段：來源由 BEACON_LOG_SOURCES_B64 指定，逐行驗證，不符的行直接略過
if [ -n "${BEACON_LOG_SOURCES_B64:-}" ]; then
  decoded=$(printf '%s' "$BEACON_LOG_SOURCES_B64" | base64 -d 2>/dev/null) \
    || decoded=$(printf '%s' "$BEACON_LOG_SOURCES_B64" | base64 -D 2>/dev/null) \
    || decoded=""
  name_re='^[A-Za-z0-9_.-]+$'
  target_re='^[A-Za-z0-9_.@/-]+$'
  seen_names=" "
  while IFS=$'\t' read -r lname ltype ltarget lextra; do
    [ -z "$lextra" ] || continue
    [[ $lname =~ $name_re ]] || continue
    [[ $ltarget =~ $target_re ]] || continue
    case "$seen_names" in *" $lname "*) continue ;; esac
    case "$ltype" in
      journal)
        seen_names="$seen_names$lname "
        section "log:$lname" log_journal "$ltarget"
        ;;
      file)
        case "$ltarget" in /*) ;; *) continue ;; esac
        seen_names="$seen_names$lname "
        section "log:$lname" log_file "$ltarget"
        ;;
    esac
  done < <(printf '%s\n' "$decoded")
fi

exit 0
