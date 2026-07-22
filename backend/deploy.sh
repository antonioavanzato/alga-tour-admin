#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ALGA · автоматический деплой бэкенда в Yandex Cloud (одной командой)
#
# Делает всё: БД → сервисный аккаунт+ключ → таблицы → обе функции →
# публичный доступ → проверка.
#
# Предварительно нужно быть аутентифицированным в yc ОДНИМ из способов:
#   • yc init            (интерактивно, в вашем браузере)          ИЛИ
#   • yc config set service-account-key key.json                   ИЛИ
#   • yc config set token <IAM-или-поддерживаемый-OAuth-токен>
#
# Запуск:  cd backend && ./deploy.sh
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

FOLDER_ID="${FOLDER_ID:-b1gpnarkgmscmsjq3pu7}"
INTAKE_FN_ID="${INTAKE_FN_ID:-d4e0j71rtc9q7026rsc3}"
ADMIN_FN_ID="${ADMIN_FN_ID:-d4eeoorunareer57v93t}"

# ── секреты/значения загружаются из локального .deploy.env ───────────
# (см. .deploy.env.example; файл .deploy.env в .gitignore и не коммитится)
if [ -f .deploy.env ]; then set -a; . ./.deploy.env; set +a; fi

: "${INTAKE_SECRET:?Задайте INTAKE_SECRET в backend/.deploy.env (см. .deploy.env.example)}"
: "${BOT_TOKEN:?Задайте BOT_TOKEN в backend/.deploy.env}"
: "${CHAT_IDS:?Задайте CHAT_IDS в backend/.deploy.env}"
: "${ADMIN_EMAILS:?Задайте ADMIN_EMAILS в backend/.deploy.env}"
: "${ADMIN_PASSWORD:?Задайте ADMIN_PASSWORD в backend/.deploy.env}"
: "${JWT_SECRET:?Задайте JWT_SECRET в backend/.deploy.env}"
: "${VAPID_PUBLIC_KEY:?Задайте VAPID_PUBLIC_KEY в backend/.deploy.env}"
: "${VAPID_PRIVATE_KEY:?Задайте VAPID_PRIVATE_KEY в backend/.deploy.env}"
: "${VAPID_SUBJECT:=mailto:admin@example.com}"

yc() { command yc --folder-id "$FOLDER_ID" "$@"; }
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# ── 1. база данных ───────────────────────────────────────────────────
say "1/6 Yandex Database (serverless)"
if ! yc ydb database get alga-db >/dev/null 2>&1; then
  yc ydb database create alga-db --serverless
fi
# ждём READY
for i in $(seq 1 30); do
  STATUS=$(yc ydb database get alga-db --format json | node -pe 'JSON.parse(require("fs").readFileSync(0)).status' 2>/dev/null || echo "")
  [ "$STATUS" = "PROVISIONING" ] || [ "$STATUS" = "CREATING" ] || break
  sleep 5
done
EP=$(yc ydb database get alga-db --format json | node -pe 'JSON.parse(require("fs").readFileSync(0)).document_api_endpoint')
echo "   Document API endpoint: $EP"

# ── 2. сервисный аккаунт + статический ключ ──────────────────────────
say "2/6 Сервисный аккаунт alga-fn + ключ доступа"
if ! yc iam service-account get alga-fn >/dev/null 2>&1; then
  yc iam service-account create --name alga-fn
fi
SA_ID=$(yc iam service-account get alga-fn --format json | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
yc resource-manager folder add-access-binding "$FOLDER_ID" \
  --role ydb.editor --subject "serviceAccount:$SA_ID" >/dev/null 2>&1 || true

if [ -f .sa-key.json ]; then
  YC_ACCESS_KEY_ID=$(node -pe 'JSON.parse(require("fs").readFileSync(".sa-key.json")).access_key_id' 2>/dev/null || echo "")
  YC_SECRET_ACCESS_KEY=$(node -pe 'JSON.parse(require("fs").readFileSync(".sa-key.json")).secret' 2>/dev/null || echo "")
fi
if [ -z "${YC_ACCESS_KEY_ID:-}" ]; then
  yc iam access-key create --service-account-name alga-fn --format json > .sa-key.json
  YC_ACCESS_KEY_ID=$(node -pe 'JSON.parse(require("fs").readFileSync(".sa-key.json")).access_key.key_id')
  YC_SECRET_ACCESS_KEY=$(node -pe 'JSON.parse(require("fs").readFileSync(".sa-key.json")).secret')
fi
echo "   ключ: ${YC_ACCESS_KEY_ID}"

# ── 3. таблицы ───────────────────────────────────────────────────────
say "3/6 Таблицы Document API"
( cd intake && [ -d node_modules ] || npm install --no-audit --no-fund --loglevel=error >/dev/null )
YDB_DOCUMENT_ENDPOINT="$EP" YC_ACCESS_KEY_ID="$YC_ACCESS_KEY_ID" YC_SECRET_ACCESS_KEY="$YC_SECRET_ACCESS_KEY" \
  node create-tables.js

# ── 4. деплой функций ────────────────────────────────────────────────
say "4/6 Деплой функции intake ($INTAKE_FN_ID)"
( cd intake && rm -f ../intake.zip && zip -qr ../intake.zip index.js package.json )
yc serverless function version create \
  --function-id "$INTAKE_FN_ID" --runtime nodejs22 --entrypoint index.handler \
  --memory 256m --execution-timeout 30s --source-path intake.zip --service-account-id "$SA_ID" \
  --environment YDB_DOCUMENT_ENDPOINT="$EP" \
  --environment YC_ACCESS_KEY_ID="$YC_ACCESS_KEY_ID" \
  --environment YC_SECRET_ACCESS_KEY="$YC_SECRET_ACCESS_KEY" \
  --environment INTAKE_SECRET="$INTAKE_SECRET" \
  --environment BOT_TOKEN="$BOT_TOKEN" \
  --environment CHAT_IDS="$CHAT_IDS" \
  --environment VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
  --environment VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
  --environment VAPID_SUBJECT="$VAPID_SUBJECT" >/dev/null
echo "   ✓ intake задеплоен"

say "Деплой функции admin-api ($ADMIN_FN_ID)"
( cd admin-api && rm -f ../admin-api.zip && zip -qr ../admin-api.zip index.js package.json )
yc serverless function version create \
  --function-id "$ADMIN_FN_ID" --runtime nodejs22 --entrypoint index.handler \
  --memory 256m --execution-timeout 30s --source-path admin-api.zip --service-account-id "$SA_ID" \
  --environment YDB_DOCUMENT_ENDPOINT="$EP" \
  --environment YC_ACCESS_KEY_ID="$YC_ACCESS_KEY_ID" \
  --environment YC_SECRET_ACCESS_KEY="$YC_SECRET_ACCESS_KEY" \
  --environment JWT_SECRET="$JWT_SECRET" \
  --environment ADMIN_EMAILS="$ADMIN_EMAILS" \
  --environment ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --environment VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" >/dev/null
echo "   ✓ admin-api задеплоен"

# ── 5. публичный доступ ──────────────────────────────────────────────
say "5/6 Публичный доступ к функциям"
yc serverless function allow-unauthenticated-invoke --id "$INTAKE_FN_ID" >/dev/null 2>&1 || true
yc serverless function allow-unauthenticated-invoke --id "$ADMIN_FN_ID" >/dev/null 2>&1 || true
echo "   ✓ обе функции публичны"

# ── 6. проверка ──────────────────────────────────────────────────────
say "6/6 Проверка"
echo -n "   admin-api login: "
curl -s -X POST "https://functions.yandexcloud.net/${ADMIN_FN_ID}?action=login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAILS%%,*}\",\"password\":\"${ADMIN_PASSWORD}\"}" | head -c 200; echo

printf '\n\033[1;32m✓ ГОТОВО. Бэкенд развёрнут.\033[0m\n'
echo "  intake:    https://functions.yandexcloud.net/${INTAKE_FN_ID}"
echo "  admin-api: https://functions.yandexcloud.net/${ADMIN_FN_ID}"
echo "  Файл .sa-key.json содержит ключ доступа — храните его, не коммитьте."
