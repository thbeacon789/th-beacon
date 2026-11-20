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
#   BEACON_LOG_SOURCES_B64  選填，base64 文字；解碼後每行 name<TAB>type<TAB>target，type 為 file、journal 或 docker
#   BEACON_ROOT             僅供測試：讀取的絕對路徑前綴。正式執行時必須為空字串（未設定）
#
# 用到的指令（全部唯讀）：
#   ss, /usr/lib/update-notifier/apt-check, apt list --upgradable, cat, apt-config dump,
#   sshd -T, journalctl, docker ps, docker inspect, docker logs, getent, ssh-keygen -lf, systemctl list-timers / list-unit-files / cat / show,
#   sha256sum, date -u +%s, base64 -d, 以及文字工具 awk grep cut tail tr printf
#
# 相容性：目標為 Ubuntu 22.04/24.04（bash 5、GNU coreutils），但避免 bash 4+ 專屬語法，
#         日期換算全部用 awk 自行計算（不用 date -d），測試可在 macOS（bash 3.2）執行。

set -u
export LC_ALL=C

# 以 root 執行且所有指令靠 PATH 解析：正式執行（BEACON_ROOT 為空）時固定 PATH，防止被劫持
if [ -z "${BEACON_ROOT:-}" ]; then
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi
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

# 字串的短雜湊（sha256 前 16 碼），供哨兵條目使用
hstr() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# 路徑輸出為 location：含異常字元（TAB、換行、空白等）者改輸出 ?path:<雜湊>
loc_of() {
  local p="${1#"$R"}"
  local path_re='^[A-Za-z0-9_./@+-]+$'
  if [[ $p =~ $path_re ]]; then printf '%s' "$p"; else printf '?path:%s' "$(hstr "$p")"; fi
}

# auth 的內容是遠端攻擊者可控的文字，所以本區段必須是整份輸出的最後一個（見檔尾）。
# Accepted 與失敗登入分開取，避免洗版把成功登入擠出去。
# 樣式錨定在「時間 主機 sshd[pid]: 」之後，否則攻擊者用帳號名 Accepted 產生的
# "Invalid user Accepted from ..." 會命中成功登入的樣式而擠掉真實紀錄。
s_auth() {
  local head_re='^[^ ]+ [^ ]+ sshd(-session)?\[[0-9]+\]: '
  # 日誌大小受遠端攻擊者影響：全程串流，不存入變數（兩次查詢之間多幾行無妨）
  journalctl -u ssh -u sshd --since '24 hours ago' --no-pager -o short-iso 2>/dev/null | grep -E "${head_re}Accepted " | tail -n 5000
  # Connection closed by (authenticating|invalid) user 也算失敗；與同連線的 Invalid user 行可能重複計，可接受
  journalctl -u ssh -u sshd --since '24 hours ago' --no-pager -o short-iso 2>/dev/null | grep -E "${head_re}(Failed password|Invalid user|Connection closed by (authenticating|invalid) user) " | tail -n 20000
}

# 可登入判斷用「完全相等」白名單；shell 為空視為可登入
s_users() {
  getent passwd | awk -F: '
    { s = $7 }
    s == "/usr/sbin/nologin" || s == "/sbin/nologin" || s == "/bin/false" || s == "/usr/bin/false" { next }
    { print $1 }
  '
}

# 解析單一 sudoers 檔：$1=檔案 $2=深度（0 為頂層，1 為被 include 引入的檔）。
# 無法解析的條目一律輸出哨兵 ?sudoers:<雜湊>，不可靜默略過。
# 頂層遇到 include 時除了哨兵，還會跟進一層（GCP OS Login 的管理員授權放在被引入的目錄）；
# 深度 1 再遇到 include 只輸出哨兵，不再遞迴。
sudoers_file() {
  local f="$1" depth="$2"
  local line first el grp arg inc g base
  local name_re='^[A-Za-z0-9_.-]+$'
  local uid_re='^#[0-9]+$'
  local inc_re='^/[A-Za-z0-9_./@+-]+$'
  local gt
  gt=$(printf '\076')
  # symlink 不讀取（可能指向任意檔），只輸出以路徑字串為雜湊的哨兵
  if [ -L "$f" ]; then
    echo "?sudoers:$(hstr "$f")"
    return 0
  fi
  [ -f "$f" ] && [ -r "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    first=$(printf '%s\n' "$line" | awk '{ gsub(/[ \t]*,[ \t]*/, ","); print $1 }')
    case "$first" in
      '#include'* | '@include'*)
        echo "?sudoers:$(hstr "$line")"
        if [ "$depth" -eq 0 ]; then
          arg=$(printf '%s\n' "$line" | awk '{ print $2 }')
          # /proc、/sys、/dev 下的特殊檔可能阻塞讀取，不跟進（用原始路徑判斷）
          case "$arg" in /proc | /proc/* | /sys | /sys/* | /dev | /dev/*) arg="" ;; esac
          # 非正規寫法（//、/./、/../ 或以 /. /.. 結尾）沒有正當理由，視同特殊路徑
          case "$arg" in *//* | */./* | */../* | */. | */..) arg="" ;; esac
          if [[ $arg =~ $inc_re ]]; then
            arg="${arg%/}"
            case "$first" in
              '#includedir' | '@includedir')
                # /etc/sudoers.d 已由預設列舉處理，不重複
                if [ "$arg" != "/etc/sudoers.d" ] && [ ! -L "$R$arg" ]; then
                  for g in "$R$arg"/*; do
                    base="${g##*/}"
                    # sudo 的 includedir 規則：略過檔名含 . 或以 ~ 結尾者
                    case "$base" in *.* | *"~") continue ;; esac
                    sudoers_file "$g" 1
                  done
                fi
                ;;
              '#include' | '@include')
                inc="$R$arg"
                sudoers_file "$inc" 1
                ;;
            esac
          fi
        fi
        continue
        ;;
      # 只略過 Defaults 與 Defaults:／@／!／>（>以變數表示，維持腳本內無導向字元）；
      # Defaults_x、Defaults.x 等是一般帳號名，須照授權行處理
      Defaults | Defaults[:@!]* | Defaults"$gt"*) continue ;;
      User_Alias | Runas_Alias | Host_Alias | Cmnd_Alias | Cmd_Alias)
        echo "?sudoers:$(hstr "$line")"
        continue
        ;;
      '#'*)
        [[ $first =~ ^#[0-9] ]] || continue
        ;;
    esac
    while IFS= read -r el; do
      [ -n "$el" ] || continue
      if [[ $el =~ $name_re ]] || [[ $el =~ $uid_re ]]; then
        printf '%s\n' "$el"
      elif [[ $el == %* ]]; then
        grp="${el#%}"
        if [[ $grp =~ $name_re ]] && [[ $grp != -* ]]; then
          printf '%s\n' "$el"
          getent group "$grp" | awk -F: '{ n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] != "") print m[i] }'
        else
          echo "?sudoers:$(hstr "$line")"
        fi
      else
        echo "?sudoers:$(hstr "$line")"
      fi
    done < <(printf '%s\n' "$first" | tr ',' '\n')
  done < "$f"
}

s_admins() {
  {
    local gids f
    getent group sudo admin | awk -F: '{ n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] != "") print m[i] }'
    gids=$(getent group sudo admin | awk -F: '{ print $3 }' | tr '\n' ' ')
    getent passwd | awk -F: -v gids="$gids" 'BEGIN { n = split(gids, a, " "); for (i = 1; i <= n; i++) g[a[i]] = 1 } ($4 in g) { print $1 }'
    for f in "$R/etc/sudoers" "$R"/etc/sudoers.d/*; do
      sudoers_file "$f" 0
    done
  } | awk '!seen[$0]++'
}

# 解析不了的金鑰行輸出 UNPARSEABLE:<雜湊>，不可略過
s_ssh_keys() {
  local user home kf f line fp cfg
  local fp_re='^[A-Za-z0-9]+:[A-Za-z0-9+/=]+$'
  while IFS=: read -r user _ _ _ _ home _; do
    [ -n "$user" ] || continue
    [ -n "$home" ] || continue
    for kf in authorized_keys authorized_keys2; do
      f="$R$home/.ssh/$kf"
      [ -f "$f" ] && [ -r "$f" ] || continue
      while IFS= read -r line || [ -n "$line" ]; do
        line="${line#"${line%%[![:space:]]*}"}"
        case "$line" in
          '' | '#'*) continue ;;
        esac
        fp=$(printf '%s\n' "$line" | ssh-keygen -lf /dev/stdin 2>/dev/null | awk '{ print $2; exit }')
        if [[ $fp =~ $fp_re ]]; then
          printf '%s\t%s\n' "$user" "$fp"
        else
          printf '%s\tUNPARSEABLE:%s\n' "$user" "$(hstr "$line")"
        fi
      done < "$f"
    done
  done < <(getent passwd)
  # 金鑰檔位置／CA 信任設定的哨兵：設定一變就會被標成新增金鑰
  cfg=$(sshd -T 2>/dev/null | awk '
    { k = tolower($1) }
    k == "authorizedkeysfile" || k == "authorizedkeyscommand" || k == "trustedusercakeys" { v[k] = (k in v ? v[k] "\n" : "") $0 }
    END {
      n = split("authorizedkeysfile authorizedkeyscommand trustedusercakeys", order, " ")
      for (i = 1; i <= n; i++) if (order[i] in v) print v[order[i]]
    }
  ')
  if [ -n "$cfg" ]; then printf '(sshd)\tCONFIG:%s\n' "$(hstr "$cfg")"; fi
}

# 單一 crontab 檔：$1=檔案 $2=是否為系統格式（1 有使用者欄／0 無）
# awk 只輸出「schedule US executable US 整行」給內部迴圈雜湊（US 為 \037），整行不會出現在 stdout
sched_file() {
  [ -f "$1" ] && [ -r "$1" ] || return 0
  local loc sch exe line hash
  loc=$(loc_of "$1")
  awk -v sys="$2" '
    {
      sub(/^[ \t]+/, ""); sub(/[ \t\r]+$/, "")
      if ($0 == "" || $0 ~ /^#/) next
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) next
      if ($1 ~ /^@/) { i = 2; sch = $1 } else {
        i = 6; sch = ""
        for (k = 1; k <= 5 && k <= NF; k++) sch = sch (k == 1 ? "" : " ") $k
      }
      if (sys == "1") i++
      exe = ""; quoted = 0
      for (; i <= NF; i++) {
        # 任何掃過的 token 含引號（如 TOKEN="a b c" 被拆開的片段），整筆 executable 留空
        if (index($i, "\047") != 0 || index($i, "\042") != 0) quoted = 1
        if (index($i, "=") == 0) { exe = $i; break }
      }
      if (quoted) exe = ""
      print sch "\037" exe "\037" $0
    }
  ' "$1" | while IFS=$'\037' read -r sch exe line; do
    hash=$(printf '%s' "$line" | sha256sum | awk '{ print $1 }')
    printf '%s\t%s\t%s\t%s\n' "$loc" "$sch" "$exe" "$hash"
  done
}

# 以檔案內容整檔雜湊的排程類檔案：$1=檔案 $2=固定的 schedule 字串
plain_file() {
  [ -f "$1" ] && [ -r "$1" ] || return 0
  local hash
  hash=$(sha256sum < "$1" 2>/dev/null | awk '{ print $1 }')
  printf '%s\t%s\t\t%s\n' "$(loc_of "$1")" "$2" "$hash"
}

s_scheduled() {
  local f unit act hash h
  local unit_re='^[-A-Za-z0-9_.@:\\]+$'
  sched_file "$R/etc/crontab" 1
  for f in "$R"/etc/cron.d/*; do sched_file "$f" 1; done
  for f in "$R"/var/spool/cron/crontabs/*; do sched_file "$f" 0; done
  for f in "$R"/etc/cron.hourly/*; do plain_file "$f" hourly; done
  for f in "$R"/etc/cron.daily/*; do plain_file "$f" daily; done
  for f in "$R"/etc/cron.weekly/*; do plain_file "$f" weekly; done
  for f in "$R"/etc/cron.monthly/*; do plain_file "$f" monthly; done
  plain_file "$R/etc/anacrontab" anacron
  for f in "$R"/var/spool/cron/atjobs/*; do plain_file "$f" at; done
  systemctl list-timers --all --no-legend 2>/dev/null \
    | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /\.timer$/) { if (!seen[$i]++) print $i " " $NF; break } }' \
    | while read -r unit act; do
      if ! [[ $unit =~ $unit_re ]]; then
        h=$(hstr "$unit")
        printf '?unit:%s\t\t\t%s\n' "$h" "$h"
        continue
      fi
      hash=$(
        {
          systemctl cat -- "$unit" 2>/dev/null < /dev/null
          if [[ $act =~ $unit_re ]] && [ "$act" != "$unit" ]; then systemctl cat -- "$act" 2>/dev/null < /dev/null; fi
        } | sha256sum | awk '{ print $1 }'
      )
      printf '%s\t\t\t%s\n' "$unit" "$hash"
    done
}

s_services() {
  systemctl list-unit-files --type=service --state=enabled --no-legend | awk '{ print $1 }'
}

# 執行中的容器清單：每個容器一行「名稱<TAB>image<TAB>ports」，正規化（去版本、只留對外埠）在解析端做。
# docker 不存在 → NONE（這台機器沒有 Docker，是合法的「沒有容器」）；docker ps 失敗 → ERROR；沒有容器 → 空。
# 欄位含不符預期字元的行輸出哨兵 ?container:<雜湊>，不輸出原文（容器名稱可能被攻擊者影響，且哨兵內容一變就會浮現）。
# 注意：`docker ps --format` 的輸出格式（\t 展開、Ports 欄位寫法）未在真實 Docker 上驗證前，以首次實跑為準。
s_containers() {
  command -v docker >/dev/null 2>&1 || { echo NONE; return 0; }
  local out line cname cimage cports cextra gt
  local cname_re='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
  local cimage_re='^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$'
  gt=$(printf '\076')
  local cports_re="^[][A-Za-z0-9_.:,${gt}/ -]*\$"
  out=$(docker ps --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null < /dev/null) || { echo ERROR; return 0; }
  printf '%s\n' "$out" | while IFS=$'\t' read -r cname cimage cports cextra; do
    [ -n "$cname$cimage$cports$cextra" ] || continue
    if [ -z "$cextra" ] && [[ $cname =~ $cname_re ]] && [[ $cimage =~ $cimage_re ]] && [[ $cports =~ $cports_re ]]; then
      printf '%s\t%s\t%s\n' "$cname" "$cimage" "$cports"
    else
      line="$cname$cimage$cports$cextra"
      echo "?container:$(hstr "$line")"
    fi
  done
}

# journal 型：先確認 unit 存在（不存在時 journalctl 仍以 0 結束且無輸出，會被誤當成「沒有 log」），
# --utc 直接輸出 UTC，取每行前 13 字元（YYYY-MM-DDTHH）以 awk 串流計數（固定記憶體；輸出順序不保證，由解析端排序）
log_journal() {
  local st
  st=$(systemctl show -p LoadState --value -- "$1" 2>/dev/null) || { echo ERROR; return 0; }
  [ "$st" = loaded ] || { echo ERROR; return 0; }
  if ! (
    set -o pipefail
    journalctl --utc -u "$1" --since '24 hours ago' --no-pager -o short-iso 2>/dev/null \
      | { grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}' || :; } \
      | awk '{ c[substr($0, 1, 13)]++ } END { for (k in c) printf "%s:00:00Z\t%d\n", k, c[k] }'
  ); then
    echo ERROR
  fi
}

# docker 型：以容器名稱計算每小時 log 行數（輸出格式與 log_journal 相同）。
# 先以 docker inspect 確認容器存在（不存在時不可當成「沒有 log」）；docker 不存在、daemon 連不上同樣 ERROR。
# stdout 與 stderr 都算 log 行（2>&1）；--timestamps 的時間為 UTC（RFC3339Nano，結尾 Z），取前 13 字元計數。
# 只輸出小時與計數，絕不輸出 log 內容（內容為遠端攻擊者可控）。
# 注意：`docker logs` 的 `--`、`--since 24h`、`--timestamps` 輸出格式未在真實 Docker 上驗證前，以首次實跑為準。
log_docker() {
  docker inspect --type container -- "$1" >/dev/null 2>&1 < /dev/null || { echo ERROR; return 0; }
  if ! (
    set -o pipefail
    docker logs --timestamps --since 24h -- "$1" 2>&1 < /dev/null \
      | { grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}' || :; } \
      | awk '{ c[substr($0, 1, 13)]++ } END { for (k in c) printf "%s:00:00Z\t%d\n", k, c[k] }'
  ); then
    echo ERROR
  fi
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
    END {
      # 依時間由舊到新輸出（至多 25 個整點，不需要外部排序）
      for (h = int(lo / 3600) * 3600; h <= now; h += 3600) if (h in c) printf "%d\t%d\n", h, c[h]
    }
  ' "$@" | awk '
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
section users s_users
section admins s_admins
section ssh_keys s_ssh_keys
section scheduled s_scheduled
section services s_services
section containers s_containers

# log:<name> 區段：來源由 BEACON_LOG_SOURCES_B64 指定，逐行驗證，不符的行直接略過
if [ -n "${BEACON_LOG_SOURCES_B64:-}" ]; then
  decoded=$(printf '%s' "$BEACON_LOG_SOURCES_B64" | base64 -d 2>/dev/null) \
    || decoded=$(printf '%s' "$BEACON_LOG_SOURCES_B64" | base64 -D 2>/dev/null) \
    || decoded=""
  name_re='^[A-Za-z0-9_.-]+$'
  target_re='^[A-Za-z0-9_.@/-]+$'
  unit_re='^[A-Za-z0-9_.@-]+$'
  container_re='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
  seen_names=" "
  while IFS=$'\t' read -r lname ltype ltarget lextra; do
    [ -z "$lextra" ] || continue
    [[ $lname =~ $name_re ]] || continue
    [[ $ltarget =~ $target_re ]] || continue
    case "$seen_names" in *" $lname "*) continue ;; esac
    case "$ltype" in
      journal)
        # unit 名稱不含 /，也不可以 - 開頭
        [[ $ltarget =~ $unit_re ]] || continue
        case "$ltarget" in -*) continue ;; esac
        seen_names="$seen_names$lname "
        section "log:$lname" log_journal "$ltarget"
        ;;
      docker)
        # 容器名稱首字元為英數，故不會以 - 開頭、不含 /
        [[ $ltarget =~ $container_re ]] || continue
        seen_names="$seen_names$lname "
        section "log:$lname" log_docker "$ltarget"
        ;;
      file)
        case "$ltarget" in /*) ;; *) continue ;; esac
        seen_names="$seen_names$lname "
        section "log:$lname" log_file "$ltarget"
        ;;
    esac
  done < <(printf '%s\n' "$decoded")
fi

# auth 必須是最後一個區段（內容為遠端攻擊者可控；解析器同名區段以第一個為準）
section auth s_auth

exit 0
