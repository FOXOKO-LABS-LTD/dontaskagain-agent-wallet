#!/usr/bin/env bash
# Screenshots of the key screens on mock data (no wallet, no Signer): builds the preview pages, serves them on
# 127.0.0.1, renders with a headless Chromium. Usage: scripts/preview/shots.sh <chrome-binary> [out-dir]
# Needs the Playwright headless shell or Chrome; if system libs are missing, set LD_LIBRARY_PATH to extracted .debs.
set -euo pipefail
CH=${1:?chrome binary}; OUT=${2:-docs/screens}
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d); PORT=9947
PREVIEW_OUT=$TMP npx vite build -c scripts/preview/vite.config.ts >/dev/null
python3 -m http.server $PORT --bind 127.0.0.1 --directory "$TMP" >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV; rm -rf "$TMP"' EXIT
sleep 1
mkdir -p "$OUT"
B=http://127.0.0.1:$PORT/scripts/preview
shot() { [[ -n "${ONLY:-}" && ! "$1" =~ $ONLY ]] && return 0; "$CH" --no-sandbox --disable-gpu --hide-scrollbars --screenshot="$OUT/$1.png" --window-size="$2" --virtual-time-budget=5000 "$3" >/dev/null 2>&1; echo "$OUT/$1.png"; }
shot 01-main            360,600  "$B/popup.html#/"
shot 02-accounts        360,600  "$B/popup.html?act=click:.acc-btn#/"
shot 03-sign-window     460,760  "$B/sign.html"
shot 04-sign-window-end 460,1500 "$B/sign.html"
shot 05-agents          360,600  "$B/popup.html#/agents"
shot 06-agents-panel-full 520,1700 "$B/panel.html#/agents"
shot 07-agent-wizard-limits 360,600 "$B/popup.html?act=type:input=claude-bot|click:.btn.primary|click:.btn.primary#/agents/new"
shot 08-agent-wizard-token  360,600 "$B/popup.html?act=type:input=claude-bot|click:.btn.primary|click:.btn.primary|click:.btn.primary#/agents/new"
shot 09-side-panel      520,900  "$B/panel.html#/"
shot 10-side-panel-request 520,900 "$B/panel.html#/sign/awr_r1"
shot 11-send            360,600  "$B/popup.html?act=click:.list-item.click|wait:200#/send"
shot 12-receive         360,600  "$B/popup.html#/receive"
shot 13-resources       360,600  "$B/popup.html#/resources"
shot 14-swap           360,600  "$B/popup.html?act=type:.pair input=10|wait:800#/swap"
shot 16-swap-sign-window 460,2300 "$B/panel.html#/sign/awr_s1"
shot 17-swap-sign-top   460,760  "$B/panel.html#/sign/awr_s1"
shot 18-transfer-new-address 460,1500 "$B/panel.html#/sign/awr_n1"
shot 19-resources-buy   360,900  "$B/panel.html?act=click:.card .tabs .tab@1|click:.card .btn@0|wait:300#/resources"
shot 15-paused          360,600  "$B/popup.html?paused=1#/agents"
# 0.1.7: accounts screen, add account, phrases, import with a name, onboarding password
PH=legal%20winner%20thank%20year%20wave%20sausage%20worth%20useful%20legal%20winner%20thank%20yellow
KEY=0x0000000000000000000000000000000000000000000000000000000000000007
shot 20-accounts-full    360,1000 "$B/popup.html#/accounts"
shot 21-accounts-search  360,600  "$B/popup.html?act=type:.search%20input=work#/accounts"
shot 22-account-add      360,900  "$B/panel.html#/accounts/add"
shot 23-account-add-import-phrase 360,1150 "$B/panel.html?act=click:.opt%20input@3|type:textarea=$PH|wait:600#/accounts/add"
shot 24-account-add-import-key 360,1100 "$B/panel.html?act=click:.opt%20input@3|click:.tabs%20.tab@1|type:input.mono=$KEY|type:.card%20input[maxlength]=cold-2|wait:600#/accounts/add"
shot 25-account-add-new-phrase 360,700 "$B/panel.html#/accounts/add/new"
shot 26-seeds            360,600  "$B/popup.html#/seeds"
shot 27-seed-delete      360,640  "$B/panel.html?act=click:.danger-ic#/seeds"
shot 28-onboarding-import 360,600 "$B/popup.html?fresh=1&act=click:.actions%20.btn@1|type:textarea=$PH#/"
shot 29-onboarding-password 360,600 "$B/popup.html?fresh=1&act=click:.actions%20.btn@1|type:textarea=$PH|click:.btn.primary#/"
shot 30-onboarding-password-panel 520,700 "$B/panel.html?fresh=1&act=click:.actions%20.btn@1|click:.tabs%20.tab@1|type:input.mono=$KEY|click:.btn.primary#/"
shot 31-settings         360,1300 "$B/panel.html#/settings"
shot 32-locked           360,600  "$B/popup.html?locked=1#/"
# EVM: all networks, bridge, refuel, EVM transfer, insufficient gas
SUB='button.btn.primary:not(%5Btype%5D)'
shot 33-home-all-networks 520,1500 "$B/panel.html?act=click:.switch%20input|wait:300#/"
shot 34-bridge-form       520,1150 "$B/panel.html?act=type:input.mono=20|wait:900#/bridge"
shot 35-bridge-sign-window 460,1900 "$B/panel.html#/sign/awr_b1"
shot 36-bridge-sign-top   460,760  "$B/panel.html#/sign/awr_b1"
shot 37-refuel-form       360,800  "$B/popup.html#/refuel"
shot 38-refuel-sign-window 460,1400 "$B/panel.html?act=click:$SUB|wait:600#/refuel"
shot 39-evm-transfer-sign-window 460,1300 "$B/panel.html?act=click:.list-item.click@5|type:input.mono=0x3214a91bCd29b8ce7D3C5E26bE1cEa3E8D57b67C|wait:400|click:.btn.primary|type:input.mono=40|click:$SUB|wait:600#/send"
shot 40-insufficient-gas-refuel 460,1300 "$B/panel.html?act=click:.list-item.click@8|type:input.mono=0x3214a91bCd29b8ce7D3C5E26bE1cEa3E8D57b67C|wait:400|click:.btn.primary|type:input.mono=12|click:$SUB|wait:600#/send"
shot 41-receive-evm       360,700  "$B/popup.html?act=click:.tabs%20.tab@2#/receive"
# 0.2.1: agent settings, new types once, token re-issue, revoke, the agent-side connection, receive texts
shot 42-agents-new-types   460,1300 "$B/panel.html#/agents"
shot 43-agent-settings     520,2900 "$B/panel.html?migrated=1#/agent/ag_7f3k"
shot 44-agent-rotate       520,1500 "$B/panel.html?migrated=1&act=text:%D0%9F%D0%B5%D1%80%D0%B5%D0%B2%D1%8B%D0%BF%D1%83%D1%81%D1%82%D0%B8%D1%82%D1%8C%20%D1%82%D0%BE%D0%BA%D0%B5%D0%BD|wait:300|scroll:.card.danger|wait:200#/agent/ag_7f3k"
shot 45-agent-wizard-connect 460,1500 "$B/panel.html?act=type:input=claude-bot|click:.btn.primary|click:.btn.primary|click:.btn.primary#/agents/new"
shot 46-agent-revoked      360,700  "$B/popup.html?act=text:%D0%9E%D1%82%D0%BE%D0%B7%D0%B2%D0%B0%D1%82%D1%8C|wait:300#/agent/ag_2bq1"
shot 12-receive            360,700  "$B/popup.html#/receive"
# 0.2.1: operation page (bridge in progress / done, refuel, swap)
shot 47-op-bridge-progress 460,1250 "$B/panel.html#/op/op_br_run"
shot 48-op-bridge-done     460,1250 "$B/panel.html#/op/op_br_done"
shot 49-op-refuel          460,900  "$B/panel.html#/op/op_rf"
shot 50-op-swap            460,1000 "$B/panel.html#/op/op_sw"
# 0.2.2: «Кому» — my accounts (grouped by phrase, balance) and the address book
shot 51-send-to-my-accounts 460,1100 "$B/panel.html?act=click:.list-item.click|wait:300|click:.card%20.list%20.list-item.click@1|wait:300#/send"
# prices + logos: coin $ from coins.ceo, logos in lists, network pickers, sign window, operation page
shot 52-main-prices-logos   360,600  "$B/popup.html#/"
shot 53-home-all-networks-logos 520,1300 "$B/panel.html?act=click:.switch%20input|wait:300#/"
shot 54-receive-network-logos 360,600 "$B/popup.html#/receive"
shot 55-bridge-network-logos 520,900 "$B/panel.html#/bridge"
shot 56-send-pick-asset-logos 360,900 "$B/popup.html#/send"
shot 57-sign-window-logo    460,760  "$B/sign.html"
shot 58-bridge-sign-logo    460,760  "$B/panel.html#/sign/awr_b1"
shot 59-swap-logos          360,600  "$B/popup.html?act=type:.pair input=10|wait:800#/swap"
# i18n: the same screens in English (?lang=en), and «Give agents access» on «Add account»
shot en-01-main            360,600  "$B/popup.html?lang=en#/"
shot en-02-sign-window     460,1500 "$B/sign.html?lang=en"
shot en-03-sign-swap       460,2300 "$B/panel.html?lang=en#/sign/awr_s1"
shot en-04-op-bridge       460,1250 "$B/panel.html?lang=en#/op/op_br_run"
shot en-05-settings        360,1400 "$B/panel.html?lang=en#/settings"
shot en-06-agents          360,900  "$B/popup.html?lang=en#/agents"
shot en-07-account-add-agents 360,1200 "$B/panel.html?lang=en&act=click:.agent-access%20input@0|type:.card%20input[maxlength]=trading#/accounts/add"
shot 60-account-add-agents 360,1200 "$B/panel.html?act=click:.agent-access%20input@0|type:.card%20input[maxlength]=trading#/accounts/add"
# 0.3.1 (i18n + E2E): main, agent connect wizard (E2E, npx), Signer settings (E2E, direct reads), add account with agents — ru and en
for L in ru en; do
  P=$([[ $L == en ]] && echo "lang=en&" || echo "")
  shot 61-$L-main             360,600  "$B/popup.html?${P}e2e=1#/"
  shot 62-$L-agent-wizard-way 460,1300 "$B/panel.html?${P}e2e=1&act=type:input=claude-bot|click:.btn.primary|click:.btn.primary#/agents/new"
  shot 63-$L-agent-connect    460,1700 "$B/panel.html?${P}e2e=1&act=type:input=claude-bot|click:.btn.primary|click:.btn.primary|click:.btn.primary|wait:300#/agents/new"
  shot 64-$L-settings-signer  460,1900 "$B/panel.html?${P}e2e=1&act=click:details%20summary@0|wait:200#/settings"
  shot 65-$L-account-add-agents 360,1200 "$B/panel.html?${P}act=click:.agent-access%20input@0|type:.card%20input[maxlength]=trading#/accounts/add"
done
