# ALGA · Развёртывание бэкенда на Yandex Cloud

Схема работы:

```
Форма на alga-tour.com ──POST──► Cloud Function «intake» ──► Yandex Database (заявки)
                                        │
                                        ├──► Telegram-канал (бот)
                                        └──► Web Push (админам)

Админка (PWA, GitHub Pages) ◄──HTTP──► Cloud Function «admin-api» ──► Yandex Database
```

Каталог (folder) Yandex Cloud: **`b1gpnarkgmscmsjq3pu7`**
Регион: **`ru-central1`**

Уже существующие функции (их ID зашиты во фронтенде — **менять нельзя**):

| Функция     | ID                        | Что делает                         |
|-------------|---------------------------|------------------------------------|
| `intake`    | `d4e0j71rtc9q7026rsc3`    | приём заявок с формы сайта         |
| `admin-api` | `d4eeoorunareer57v93t`    | API для админ-панели               |

---

## 0. Предварительно: установить и настроить `yc`

```bash
curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
exec -l $SHELL
yc init                       # войти в аккаунт, выбрать облако
yc config set folder-id b1gpnarkgmscmsjq3pu7
```

Всё ниже можно сделать и через веб-консоль — команды `yc` даны как самый быстрый путь.

---

## 1. База данных (Yandex Database, serverless)

```bash
yc ydb database create alga-db --serverless
yc ydb database get alga-db
```

В выводе найдите два значения:

* **Document API endpoint** — вида
  `https://docapi.serverless.yandexcloud.net/ru-central1/b1gpnarkgmscmsjq3pu7/etn0XXXXXXXXXXXX`
  Это и есть `YDB_DOCUMENT_ENDPOINT`.
* Endpoint / Database path — пригодятся при желании смотреть данные через консоль.

> Serverless YDB тарифицируется по факту запросов/трафика — при нескольких заявках
> в день расходы близки к нулю.

---

## 2. Сервисный аккаунт и статический ключ доступа

Функции и создание таблиц ходят в БД по статическому ключу (Document API совместим с AWS).

```bash
# сервисный аккаунт
yc iam service-account create --name alga-fn

SA_ID=$(yc iam service-account get alga-fn --format json | jq -r .id)

# права: работа с YDB + вызов функций
yc resource-manager folder add-access-binding b1gpnarkgmscmsjq3pu7 \
  --role ydb.editor --subject serviceAccount:$SA_ID

# статический ключ (это и есть YC_ACCESS_KEY_ID / YC_SECRET_ACCESS_KEY)
yc iam access-key create --service-account-name alga-fn --format json
```

Сохраните `key_id` (→ `YC_ACCESS_KEY_ID`) и `secret` (→ `YC_SECRET_ACCESS_KEY`).
**Секрет показывается один раз.**

---

## 3. Создать таблицы Document API

Понадобится AWS CLI (Document API совместим с DynamoDB):

```bash
pip install awscli
export AWS_ACCESS_KEY_ID=<YC_ACCESS_KEY_ID>
export AWS_SECRET_ACCESS_KEY=<YC_SECRET_ACCESS_KEY>
export AWS_DEFAULT_REGION=ru-central1
EP=<YDB_DOCUMENT_ENDPOINT>     # см. шаг 1

# Таблица заявок: ключ id (строка)
aws dynamodb create-table --endpoint "$EP" \
  --table-name alga_bookings \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH

# Таблица подписок Web Push: ключ endpoint (строка)
aws dynamodb create-table --endpoint "$EP" \
  --table-name alga_push_subs \
  --attribute-definitions AttributeName=endpoint,AttributeType=S \
  --key-schema AttributeName=endpoint,KeyType=HASH
```

Либо запустите готовый скрипт: `./setup-db.sh <YDB_DOCUMENT_ENDPOINT>`
(предварительно экспортировав ключи, см. `setup-db.sh`).

---

## 4. Значения переменных окружения

⚠️ **Секреты НЕ хранятся в репозитории.** Скопируйте шаблон и впишите значения
в локальный файл `.deploy.env` (он в `.gitignore` и никогда не коммитится):

```bash
cp .deploy.env.example .deploy.env
# затем откройте .deploy.env и впишите реальные значения
```

Список переменных (что это и откуда взять) — в `.deploy.env.example`:

| Переменная         | Что это                                                            |
|--------------------|-------------------------------------------------------------------|
| `INTAKE_SECRET`    | секретный ключ формы (совпадает с `SECRET_KEY` в коде формы)       |
| `BOT_TOKEN`        | токен Telegram-бота (от @BotFather)                               |
| `CHAT_IDS`         | ID канала/чата для уведомлений                                     |
| `ADMIN_EMAILS`     | почты админов через запятую                                        |
| `ADMIN_PASSWORD`   | общий пароль входа в админку                                       |
| `JWT_SECRET`       | случайный секрет для подписи токенов (`node gen-keys.js`)          |
| `VAPID_PUBLIC_KEY` | публичный ключ Web Push (`node gen-keys.js`)                       |
| `VAPID_PRIVATE_KEY`| приватный ключ Web Push (`node gen-keys.js`)                       |
| `VAPID_SUBJECT`    | `mailto:` контакт для Web Push                                     |

> Сгенерировать `JWT_SECRET` и пару `VAPID_*`: `node backend/gen-keys.js`
> Если поменяете `VAPID_PUBLIC_KEY` — старые подписки в браузерах перестанут работать,
> админам нужно будет заново нажать «колокольчик».

---

## 5. Задеплоить функции

Проще всего — одной командой: `./deploy.sh` (он читает секреты из `.deploy.env`,
создаёт/обновляет функции, ставит публичный доступ и инициализирует таблицы).

Вручную каждая функция деплоится так (секреты подставляются из окружения `.deploy.env`,
их **не пишут в открытом виде** в команды):

```bash
cd backend/intake
zip -r ../intake.zip index.js package.json

yc serverless function version create \
  --function-id <INTAKE_FN_ID> \
  --runtime nodejs22 --entrypoint index.handler --memory 256m --execution-timeout 30s \
  --source-path ../intake.zip --service-account-id $SA_ID \
  --environment YDB_DOCUMENT_ENDPOINT="$EP" \
  --environment YC_ACCESS_KEY_ID="$AK" --environment YC_SECRET_ACCESS_KEY="$SK" \
  --environment INTAKE_SECRET="$INTAKE_SECRET" \
  --environment BOT_TOKEN="$BOT_TOKEN" --environment CHAT_IDS="$CHAT_IDS" \
  --environment VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
  --environment VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
  --environment VAPID_SUBJECT="$VAPID_SUBJECT"
```

admin-api — аналогично, с переменными `JWT_SECRET`, `ADMIN_EMAILS`, `ADMIN_PASSWORD`,
`VAPID_PUBLIC_KEY` (см. `deploy.sh`).

---

## 6. Сделать функции публичными

Форма и админка вызывают функции без авторизации Yandex — нужен публичный доступ:

```bash
yc serverless function allow-unauthenticated-invoke --id <INTAKE_FN_ID>
yc serverless function allow-unauthenticated-invoke --id <ADMIN_FN_ID>
```

---

## 7. Проверка

**intake** (без ключа `403`, с ключом `200`):

```bash
curl -i -X POST https://functions.yandexcloud.net/<INTAKE_FN_ID> \
  --data-urlencode "key=$INTAKE_SECRET" --data-urlencode 'fio=Тест' \
  --data-urlencode 'phone=+79990000000' --data-urlencode 'service_type=excursion' \
  --data-urlencode 'excursion=АКВАРИУМ' --data-urlencode 'excursion_date=2026-08-01' \
  --data-urlencode 'people_count=2' --data-urlencode 'departure_island=Мале'
```

**admin-api** (логин):

```bash
curl -s -X POST 'https://functions.yandexcloud.net/<ADMIN_FN_ID>?action=login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"<почта-админа>","password":"<пароль>"}'
# → {"token":"…","email":"…"}
```

---

## Готово

* **Форма** на сайте уже указывает на `d4e0j71rtc9q7026rsc3` — менять ничего не нужно.
* **Админка** (`admin/index.html`) уже указывает на `d4eeoorunareer57v93t` и получает
  VAPID-ключ из API — фронтенд не трогаем.
* **3 админа** уже прописаны в `ADMIN_EMAILS`, общий пароль — в `ADMIN_PASSWORD`.
* Firebase и Google Apps Script больше не используются.
