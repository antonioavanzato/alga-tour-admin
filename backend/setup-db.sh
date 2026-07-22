#!/usr/bin/env bash
# Создаёт таблицы Document API в Yandex Database.
# Использование:
#   export AWS_ACCESS_KEY_ID=<YC_ACCESS_KEY_ID>
#   export AWS_SECRET_ACCESS_KEY=<YC_SECRET_ACCESS_KEY>
#   ./setup-db.sh <YDB_DOCUMENT_ENDPOINT>
set -euo pipefail

EP="${1:?Укажите YDB Document API endpoint первым аргументом}"
export AWS_DEFAULT_REGION=ru-central1

echo "→ Создаю таблицу alga_bookings…"
aws dynamodb create-table --endpoint "$EP" \
  --table-name alga_bookings \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  || echo "  (уже существует — пропускаю)"

echo "→ Создаю таблицу alga_push_subs…"
aws dynamodb create-table --endpoint "$EP" \
  --table-name alga_push_subs \
  --attribute-definitions AttributeName=endpoint,AttributeType=S \
  --key-schema AttributeName=endpoint,KeyType=HASH \
  || echo "  (уже существует — пропускаю)"

echo "✓ Готово. Таблицы:"
aws dynamodb list-tables --endpoint "$EP"
