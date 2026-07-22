'use strict';
// Создаёт таблицы Document API в Yandex Database.
// Запуск: node create-tables.js
// Требует env: YDB_DOCUMENT_ENDPOINT, YC_ACCESS_KEY_ID, YC_SECRET_ACCESS_KEY
const { DynamoDBClient, CreateTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb');

const { YDB_DOCUMENT_ENDPOINT, YC_ACCESS_KEY_ID, YC_SECRET_ACCESS_KEY } = process.env;
if (!YDB_DOCUMENT_ENDPOINT || !YC_ACCESS_KEY_ID || !YC_SECRET_ACCESS_KEY) {
  console.error('Нужны env: YDB_DOCUMENT_ENDPOINT, YC_ACCESS_KEY_ID, YC_SECRET_ACCESS_KEY');
  process.exit(1);
}

const client = new DynamoDBClient({
  region: 'ru-central1',
  endpoint: YDB_DOCUMENT_ENDPOINT,
  credentials: { accessKeyId: YC_ACCESS_KEY_ID, secretAccessKey: YC_SECRET_ACCESS_KEY },
});

const tables = [
  { TableName: 'alga_bookings', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }] },
  { TableName: 'alga_push_subs', KeySchema: [{ AttributeName: 'endpoint', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'endpoint', AttributeType: 'S' }] },
];

(async () => {
  const existing = new Set(((await client.send(new ListTablesCommand({}))).TableNames) || []);
  for (const t of tables) {
    if (existing.has(t.TableName)) { console.log(`= ${t.TableName} уже существует`); continue; }
    await client.send(new CreateTableCommand(t));
    console.log(`+ создана ${t.TableName}`);
  }
  console.log('✓ таблицы готовы');
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
