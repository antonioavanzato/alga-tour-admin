'use strict';

/**
 * ALGA — API админ-панели (admin-api)
 * ───────────────────────────────────
 * Обслуживает PWA-админку (admin/index.html на GitHub Pages).
 * Действия (?action=…):
 *   login     POST  {email,password}          → {token,email}
 *   vapid     GET                             → {key}
 *   subscribe POST  {subscription}            → {ok:true}
 *   bookings  GET                             → {bookings:[…]}   (новые сверху)
 *   status    POST  {id,status}               → {ok:true}
 *   delete    POST  {id}                       → {ok:true}
 * Все действия кроме login/vapid требуют заголовок X-Alga-Token.
 *
 * URL функции: https://functions.yandexcloud.net/d4eeoorunareer57v93t
 * Админка на другом домене → нужны CORS-заголовки на каждом ответе.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const jwt = require('jsonwebtoken');

const {
  YDB_DOCUMENT_ENDPOINT,
  YC_ACCESS_KEY_ID,
  YC_SECRET_ACCESS_KEY,
  JWT_SECRET,
  ADMIN_EMAILS,
  ADMIN_PASSWORD,
  VAPID_PUBLIC_KEY,
  BOOKINGS_TABLE = 'alga_bookings',
  SUBS_TABLE = 'alga_push_subs',
} = process.env;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: 'ru-central1',
    endpoint: YDB_DOCUMENT_ENDPOINT,
    credentials: { accessKeyId: YC_ACCESS_KEY_ID, secretAccessKey: YC_SECRET_ACCESS_KEY },
  }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const ADMINS = (ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const VALID_STATUS = new Set(['new', 'progress', 'done', 'cancel']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Alga-Token',
  'Access-Control-Max-Age': '86400',
};
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }, body: JSON.stringify(obj) });

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function getHeader(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || null;
}

function requireAuth(event) {
  const token = getHeader(event, 'X-Alga-Token');
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

// ── действия ────────────────────────────────────────────────────────
async function login(body) {
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!ADMINS.includes(email) || password !== ADMIN_PASSWORD) return json(401, { error: 'invalid' });
  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
  return json(200, { token, email });
}

async function listBookings() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: BOOKINGS_TABLE, ExclusiveStartKey }));
    (res.Items || []).forEach((i) => items.push(i));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  items.sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));
  return json(200, { bookings: items });
}

async function setStatus(body) {
  const id = (body.id || '').toString();
  const status = (body.status || '').toString();
  if (!id || !VALID_STATUS.has(status)) return json(400, { error: 'bad request' });
  await ddb.send(new UpdateCommand({
    TableName: BOOKINGS_TABLE, Key: { id },
    UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': status },
  }));
  return json(200, { ok: true });
}

async function remove(body) {
  const id = (body.id || '').toString();
  if (!id) return json(400, { error: 'bad request' });
  await ddb.send(new DeleteCommand({ TableName: BOOKINGS_TABLE, Key: { id } }));
  return json(200, { ok: true });
}

async function subscribe(body, auth) {
  const sub = body.subscription;
  if (!sub || !sub.endpoint) return json(400, { error: 'bad request' });
  await ddb.send(new PutCommand({
    TableName: SUBS_TABLE,
    Item: { endpoint: sub.endpoint, subscription: JSON.stringify(sub), email: auth.email, created_ts: Date.now() },
  }));
  return json(200, { ok: true });
}

// ── handler ─────────────────────────────────────────────────────────
module.exports.handler = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};
  const action = params.action || '';
  const body = method === 'POST' ? parseBody(event) : {};

  try {
    if (action === 'login') return await login(body);
    if (action === 'vapid') return json(200, { key: VAPID_PUBLIC_KEY });

    // ниже — только для авторизованных
    const auth = requireAuth(event);
    if (!auth) return json(401, { error: 'unauthorized' });

    if (action === 'bookings') return await listBookings();
    if (action === 'status') return await setStatus(body);
    if (action === 'delete') return await remove(body);
    if (action === 'subscribe') return await subscribe(body, auth);

    return json(404, { error: 'unknown action' });
  } catch (e) {
    console.error(action, e.message);
    return json(500, { error: 'server error' });
  }
};
