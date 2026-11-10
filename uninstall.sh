#!/usr/bin/env bash
# Remove Passeur from Cloudflare and Telegram. Asks before each irreversible step.
set -euo pipefail
cd "$(dirname "$0")"

NAME=passeur

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
envget() { node scripts/env.mjs get "$1"; }
wr() { npx --no-install wrangler "$@"; }
confirm() { local a; read -rp "$1 [y/N] " a; [ "$a" = y ] || [ "$a" = Y ]; }

[ -t 0 ] || { echo "请在交互终端里运行" >&2; exit 1; }
t=$(envget CLOUDFLARE_API_TOKEN); a=$(envget CLOUDFLARE_ACCOUNT_ID)
if [ -n "$t" ]; then export CLOUDFLARE_API_TOKEN="$t"; fi
if [ -n "$a" ]; then export CLOUDFLARE_ACCOUNT_ID="$a"; fi

if [ -n "$(envget BOT_TOKEN)" ] && confirm "解除 Telegram webhook（bot 将不再响应）？"; then
  printf 'url = "https://api.telegram.org/bot%s/deleteWebhook"\n' "$(envget BOT_TOKEN)" |
    curl -sS --max-time 20 -K - -d '' && echo
fi

if confirm "删除 Cloudflare Worker $NAME（含它的 secrets 和 5 分钟定时任务）？"; then
  wr delete --name "$NAME"
fi

if confirm "删除 D1 数据库 $NAME？用户列表、拉黑记录、消息对应关系都会永久丢失"; then
  wr d1 delete "$NAME" -y
fi

say "完成。Telegram 里的管理群和话题不会被删除；本目录的 .env 里还有 Bot Token，不需要的话自行删除。"
