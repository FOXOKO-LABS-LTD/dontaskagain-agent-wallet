#!/usr/bin/env bash
# 0.3.6 UI kit 1.1.1: the key screens in both themes and both languages (mock data, same harness as shots.sh).
# Usage: scripts/preview/shots-ui-kit.sh <chrome-binary> [out-dir]   (ONLY=<regex> limits the set,
# DPR=2 for a zoomed check, PORT=<n> if 9951 is taken; 0.3.7: + side panel 300 px; 0.3.8: + connect step per MCP client; 0.3.13: + OAuth consent, cloud agent)
set -euo pipefail
CH=${1:?chrome binary}; OUT=${2:-docs/screens-ui-kit}
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d); PORT=${PORT:-9951}
PREVIEW_OUT=$TMP npx vite build -c scripts/preview/vite.config.ts >/dev/null
python3 -m http.server $PORT --bind 127.0.0.1 --directory "$TMP" >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV; rm -rf "$TMP"' EXIT
sleep 1
mkdir -p "$OUT"
B=http://127.0.0.1:$PORT/scripts/preview
shot() { [[ -n "${ONLY:-}" && ! "$1" =~ $ONLY ]] && return 0; "$CH" --force-device-scale-factor=${DPR:-1} --no-sandbox --disable-gpu --hide-scrollbars --screenshot="$OUT/$1.png" --window-size="$2" --virtual-time-budget=5000 "$3" >/dev/null 2>&1; echo "$OUT/$1.png"; }
PH=legal%20winner%20thank%20year%20wave%20sausage%20worth%20useful%20legal%20winner%20thank%20yellow
for TH in light dark; do for L in ru en; do
  P="theme=$TH&lang=$L"; N="$TH-$L"
  # popup 360×600
  shot popup-$N-01-main        360,600  "$B/popup.html?$P#/"
  shot popup-$N-02-agents      360,600  "$B/popup.html?$P#/agents"
  shot popup-$N-03-history     360,600  "$B/popup.html?$P#/history"
  shot popup-$N-04-onboarding  360,600  "$B/popup.html?$P&fresh=1#/"
  shot popup-$N-05-locked      360,600  "$B/popup.html?$P&locked=1#/"
  shot popup-$N-06-receive     360,600  "$B/popup.html?$P#/receive"
  shot popup-$N-07-send-warning 360,600 "$B/popup.html?$P&act=click:.list-item.click|wait:200|type:input.mono=TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdX|wait:800|scroll:.plate.bad#/send"
  shot popup-$N-08-wizard-connect 360,600 "$B/popup.html?$P&act=type:input=claude-bot|click:.btn.primary|click:.btn.primary|click:.btn.primary|wait:300|scroll:.with-mascot#/agents/new"
  shot panel-$N-06-settings    360,1700 "$B/panel.html?$P#/settings"
  shot popup-$N-10-op-done     360,600  "$B/popup.html?$P#/op/op_br_done"
  shot popup-$N-11-op-progress 360,600  "$B/popup.html?$P#/op/op_br_run"
  shot popup-$N-13-op-rejected 360,600  "$B/popup.html?$P#/op/op_rej"
  shot popup-$N-14-op-failed   360,600  "$B/popup.html?$P#/op/op_fail"
  shot popup-$N-12-accounts    360,600  "$B/popup.html?$P#/accounts"
  # side panel
  shot panel-$N-01-main        420,900  "$B/panel.html?$P#/"
  shot panel-$N-02-request     420,1500 "$B/panel.html?$P#/sign/awr_r1"
  shot panel-$N-03-all-networks 420,1300 "$B/panel.html?$P&act=click:.switch%20input|wait:300#/"
  shot panel-$N-04-swap-sign   460,2300 "$B/panel.html?$P#/sign/awr_s1"
  shot panel-$N-05-bridge-sign 460,1900 "$B/panel.html?$P#/sign/awr_b1"
  # side panel at its narrowest (300 px, 0.3.7)
  shot panel300-$N-01-main     300,900  "$B/panel.html?$P#/"
  shot panel300-$N-06-settings 300,1900 "$B/panel.html?$P#/settings"
  # 0.3.8: the connect step for the three MCP clients (E2E npx way)
  for CL in claude codex json; do
    shot panel-$N-15-connect-$CL 420,2600 "$B/panel.html?$P&e2e=1&client=$CL&act=type:input=claude-bot|click:.btn.primary|click:.btn.primary|click:.btn.primary|wait:400|click:details%20summary|wait:200#/agents/new"
  done
  # 0.3.12: E2E with the public Signer — History (own operations + chain rows), the operation pages
  shot popup-$N-16-e2e-history    360,600  "$B/popup.html?$P&e2e=public#/history"
  shot panel-$N-16-e2e-history    420,1100 "$B/panel.html?$P&e2e=public#/history"
  shot popup-$N-17-e2e-op-progress 360,600 "$B/popup.html?$P&e2e=public#/op/op_e2e_run"
  shot panel-$N-17-e2e-op-progress 420,1000 "$B/panel.html?$P&e2e=public#/op/op_e2e_run"
  shot panel-$N-18-e2e-op-done    420,1000 "$B/panel.html?$P&e2e=public#/op/op_e2e_done"
  shot panel-$N-19-e2e-op-chain   420,900  "$B/panel.html?$P&e2e=public#/op/chain%3Aevm%3A8453%3A0x9a9a%3A3"
  # 0.3.13: a chat app through OAuth — the consent screen (and a loopback redirect), the cloud agent's mark
  shot panel-$N-20-oauth-code      420,700  "$B/panel.html?$P&cloud=1#/oauth"
  shot panel-$N-21-oauth-consent   420,1500 "$B/panel.html?$P&cloud=1#/oauth/ABCD-EFGH"
  shot panel-$N-22-oauth-loopback  420,1500 "$B/panel.html?$P&cloud=1&loop=1#/oauth/ABCD-EFGH"
  shot panel-$N-23-cloud-agents    420,1400 "$B/panel.html?$P&cloud=1&migrated=1&act=scroll:.card#/agents"
  shot panel-$N-24-cloud-settings  420,1700 "$B/panel.html?$P&cloud=1#/agent/ag_cloud"
  shot panel-$N-25-cloud-sign      420,1500 "$B/panel.html?$P&cloud=1#/sign/awr_c1"
  shot panel-$N-26-cloud-op        420,1000 "$B/panel.html?$P&cloud=1#/op/op_cloud"
  shot panel-$N-27-cloud-history   420,1000 "$B/panel.html?$P&cloud=1#/history"
  # sign window
  shot sign-$N-01-top          460,760  "$B/sign.html?$P"
  shot sign-$N-02-full         460,1500 "$B/sign.html?$P"
  shot sign-$N-03-new-address  460,1500 "$B/panel.html?$P#/sign/awr_n1"
done; done
