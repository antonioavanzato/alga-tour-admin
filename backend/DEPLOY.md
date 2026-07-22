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

Ключи VAPID и JWT уже сгенерированы для этого проекта (можно перегенерировать, см. ниже):

```
VAPID_PUBLIC_KEY   = BMkHwgzjJDP1yvJje0J56oYhe60YdZNxpsYWLUVI8oxsW-a-a_0wilwhKOKFMFPuTd0pKo5jkh8oaAwRQEa_ipI
VAPID_PRIVATE_KEY  = L7rxtWJXWAB0q5LTJFJjT_U9N_L1o1_Q6TB3Kn5QfaY
VAPID_SUBJECT      = mailto:algatours@yahoo.com
JWT_SECRET         = 1e3d2cdf3667b8e3804b0f0b44f5b89fe5b830c3bf61379da68a512782ecf656
INTAKE_SECRET      = Alga2026!
BOT_TOKEN          = 8486028744:AAE4ngWmqb16UR4bgG-dvIGdKJ8tem11zJU
CHAT_IDS           = -1003526797295
ADMIN_EMAILS       = antonioavanzato@gmail.com,Ymilia@ya.ru,algatours@yahoo.com
ADMIN_PASSWORD     = MaldivesLive2026!
```

> Перегенерировать VAPID/JWT при необходимости:
> `node backend/gen-keys.js`
> Если поменяете `VAPID_PUBLIC_KEY` — старые подписки в браузерах перестанут работать,
> админам нужно будет заново нажать «колокольчик».

---

## 5. Задеплоить функции

Каждая функция — отдельная папка с `index.js` + `package.json`. Yandex сам ставит
зависимости из `package.json` при сборке версии.

### intake

```bash
cd backend/intake
zip -r ../intake.zip index.js package.json

yc serverless function version create \
  --function-id d4e0j71rtc9q7026rsc3 \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 30s \
  --source-path ../intake.zip \
  --service-account-id $SA_ID \
  --environment YDB_DOCUMENT_ENDPOINT=<EP> \
  --environment YC_ACCESS_KEY_ID=<key_id> \
  --environment YC_SECRET_ACCESS_KEY=<secret> \
  --environment INTAKE_SECRET='Alga2026!' \
  --environment BOT_TOKEN='8486028744:AAE4ngWmqb16UR4bgG-dvIGdKJ8tem11zJU' \
  --environment CHAT_IDS='-1003526797295' \
  --environment VAPID_PUBLIC_KEY='BMkHwgzjJDP1yvJje0J56oYhe60YdZNxpsYWLUVI8oxsW-a-a_0wilwhKOKFMFPuTd0pKo5jkh8oaAwRQEa_ipI' \
  --environment VAPID_PRIVATE_KEY='L7rxtWJXWAB0q5LTJFJjT_U9N_L1o1_Q6TB3Kn5QfaY' \
  --environment VAPID_SUBJECT='mailto:algatours@yahoo.com'
```

### admin-api

```bash
cd ../admin-api
zip -r ../admin-api.zip index.js package.json

yc serverless function version create \
  --function-id d4eeoorunareer57v93t \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 30s \
  --source-path ../admin-api.zip \
  --service-account-id $SA_ID \
  --environment YDB_DOCUMENT_ENDPOINT=<EP> \
  --environment YC_ACCESS_KEY_ID=<key_id> \
  --environment YC_SECRET_ACCESS_KEY=<secret> \
  --environment JWT_SECRET='1e3d2cdf3667b8e3804b0f0b44f5b89fe5b830c3bf61379da68a512782ecf656' \
  --environment ADMIN_EMAILS='antonioavanzato@gmail.com,Ymilia@ya.ru,algatours@yahoo.com' \
  --environment ADMIN_PASSWORD='MaldivesLive2026!' \
  --environment VAPID_PUBLIC_KEY='BMkHwgzjJDP1yvJje0J56oYhe60YdZNxpsYWLUVI8oxsW-a-a_0wilwhKOKFMFPuTd0pKo5jkh8oaAwRQEa_ipI'
```

---

## 6. Сделать функции публичными

Форма и админка вызывают функции без авторизации Yandex — нужен публичный доступ:

```bash
yc serverless function allow-unauthenticated-invoke --id d4e0j71rtc9q7026rsc3
yc serverless function allow-unauthenticated-invoke --id d4eeoorunareer57v93t
```

---

## 7. Проверка

**intake** (должен вернуть `403 Forbidden` без ключа и `200 OK` с ключом):

```bash
curl -i -X POST https://functions.yandexcloud.net/d4e0j71rtc9q7026rsc3 \
  -d 'key=Alga2026!&fio=Тест&phone=+79990000000&service_type=excursion&excursion=АКВАРИУМ&excursion_date=2026-08-01&people_count=2&departure_island=Мале'
```

После этого должно прийти сообщение в Telegram-канал и появиться заявка в админке.

**admin-api** (логин):

```bash
curl -s -X POST 'https://functions.yandexcloud.net/d4eeoorunareer57v93t?action=login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"algatours@yahoo.com","password":"MaldivesLive2026!"}'
# → {"token":"…","email":"algatours@yahoo.com"}
```

---

## Готово

* **Форма** на сайте уже указывает на `d4e0j71rtc9q7026rsc3` — менять ничего не нужно.
* **Админка** (`admin/index.html`) уже указывает на `d4eeoorunareer57v93t` и получает
  VAPID-ключ из API — фронтенд не трогаем.
* **3 админа** уже прописаны в `ADMIN_EMAILS`, общий пароль — в `ADMIN_PASSWORD`.
* Firebase и Google Apps Script больше не используются.
