'use strict';

/**
 * ALGA — рассыльщик уведомлений (alga-notify)
 * ───────────────────────────────────────────
 * Запускается по таймеру (раз в минуту). Находит заявки, по которым
 * уведомления ещё не отправлены (notified != true), и шлёт Telegram + Web Push
 * с жёсткими таймаутами и повторами. Так нестабильность исходящих запросов из
 * Yandex Cloud не теряет уведомления и не влияет на форму.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const webpush = require('web-push');
const https = require('https');

const {
  YDB_DOCUMENT_ENDPOINT, YC_ACCESS_KEY_ID, YC_SECRET_ACCESS_KEY,
  BOT_TOKEN, CHAT_IDS, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
  BOOKINGS_TABLE = 'alga_bookings', SUBS_TABLE = 'alga_push_subs',
  MAX_ATTEMPTS = '10',
} = process.env;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: 'ru-central1', endpoint: YDB_DOCUMENT_ENDPOINT,
    credentials: { accessKeyId: YC_ACCESS_KEY_ID, secretAccessKey: YC_SECRET_ACCESS_KEY },
  }),
  { marshallOptions: { removeUndefinedValues: true } }
);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:algatours@yahoo.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const TYPE_LABEL = {
  excursion: 'Морская экскурсия', resort: 'Выезд на резорт', hotel: 'Бронирование отеля',
  author: 'Авторский тур', diving: 'Дайвинг', sport: 'Активный спорт',
};
const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : (s || ''); };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// ── Telegram: возвращает true при доставке ──────────────────────────
function tgSendOne(chat_id, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { if (res.statusCode !== 200) console.error('tg http', res.statusCode, d.slice(0, 200)); resolve(res.statusCode === 200); }); });
    req.setTimeout(8000, () => { console.error('tg timeout'); req.destroy(); });
    req.on('error', (e) => { console.error('tg error', e.message); resolve(false); });
    req.write(payload); req.end();
  });
}
async function tgSend(text) {
  if (!BOT_TOKEN || !CHAT_IDS) return true; // нечего слать — считаем «доставлено»
  const chats = CHAT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  const results = await Promise.all(chats.map((c) => tgSendOne(c, text)));
  return results.every(Boolean);
}

function tgMessage(b) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const L = [];
  L.push('🔔 <b>Новая заявка ALGA</b>');
  L.push(`<b>${esc(TYPE_LABEL[b.service_type] || b.service_type)}</b>`);
  L.push('');
  L.push(`👤 <b>${esc(b.fio) || '—'}</b>`);
  L.push(`📞 ${esc(b.phone) || '—'}`);
  if (b.service) L.push(`🏝 ${esc(b.service)}`);
  if (b.service_type === 'hotel') {
    if (b.date1) L.push(`📅 Заезд: ${fmtDate(b.date1)}`);
    if (b.date2) L.push(`📅 Выезд: ${fmtDate(b.date2)}`);
    if (b.people) L.push(`🚪 Номеров: ${esc(b.people)}`);
    if (b.guests) L.push(`👥 Гостей: ${esc(b.guests)}`);
  } else if (b.service_type === 'author') {
    if (b.date1) L.push(`📅 Начало: ${fmtDate(b.date1)}`);
    if (b.date2) L.push(`📅 Окончание: ${fmtDate(b.date2)}`);
    if (b.people) L.push(`👥 Человек: ${esc(b.people)}`);
  } else {
    if (b.date1) L.push(`📅 Дата: ${fmtDate(b.date1)}`);
    if (b.people) L.push(`👥 Человек: ${esc(b.people)}`);
  }
  if (b.island) L.push(`🚤 Выезд с острова: ${esc(b.island)}`);
  if (b.transfer) L.push('🚗 Приватный трансфер: да');
  if (b.notes) L.push(`📝 ${esc(b.notes)}`);
  L.push('');
  L.push(`🕒 ${esc(b.received)}`);
  return L.join('\n');
}

// ── Web Push (каждая отправка ограничена таймаутом) ─────────────────
async function pushAll(b) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  let subs = [];
  try { subs = (await ddb.send(new ScanCommand({ TableName: SUBS_TABLE }))).Items || []; }
  catch (e) { console.error('scan subs', e.message); return; }
  const payload = JSON.stringify({
    title: '🔔 Новая заявка ALGA',
    body: `${b.fio || 'Без имени'} · ${TYPE_LABEL[b.service_type] || ''} · ${b.phone || ''}`,
  });
  await Promise.allSettled(subs.map(async (row) => {
    try { await withTimeout(webpush.sendNotification(JSON.parse(row.subscription), payload), 8000); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { await ddb.send(new DeleteCommand({ TableName: SUBS_TABLE, Key: { endpoint: row.endpoint } })); } catch (_) {}
      } else { console.error('push', e.statusCode || e.message); }
    }
  }));
}

// ── handler (таймер) ────────────────────────────────────────────────
module.exports.handler = async () => {
  let items = [];
  try { items = (await ddb.send(new ScanCommand({ TableName: BOOKINGS_TABLE }))).Items || []; }
  catch (e) { console.error('scan bookings', e.message); return { statusCode: 500 }; }

  const pending = items.filter((b) => b.notified !== true).sort((a, b) => (a.created_ts || 0) - (b.created_ts || 0)).slice(0, 20);
  let sent = 0;
  for (const b of pending) {
    const attempts = (b.notify_attempts || 0) + 1;
    const tgOk = await tgSend(tgMessage(b));
    await pushAll(b); // best-effort
    const done = tgOk || attempts >= Number(MAX_ATTEMPTS);
    try {
      await ddb.send(new UpdateCommand({
        TableName: BOOKINGS_TABLE, Key: { id: b.id },
        UpdateExpression: 'SET notified = :n, notify_attempts = :a',
        ExpressionAttributeValues: { ':n': done, ':a': attempts },
      }));
    } catch (e) { console.error('update notified', b.id, e.message); }
    if (tgOk) sent++;
  }
  return { statusCode: 200, body: JSON.stringify({ pending: pending.length, sent }) };
};
