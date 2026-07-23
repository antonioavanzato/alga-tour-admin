'use strict';

/**
 * ALGA — функция приёма заявок (intake)
 * ─────────────────────────────────────
 * Принимает POST с формы сайта alga-tour.com, сохраняет заявку в
 * Yandex Database (Document API, совместимый с DynamoDB), отправляет
 * уведомление в Telegram-канал и Web Push всем подписанным админам.
 *
 * URL функции: https://functions.yandexcloud.net/d4e0j71rtc9q7026rsc3
 * Форма шлёт данные обычным POST (application/x-www-form-urlencoded)
 * в скрытый iframe, поэтому CORS не требуется — достаточно вернуть 200.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const webpush = require('web-push');
const crypto = require('crypto');
const https = require('https');

const {
  YDB_DOCUMENT_ENDPOINT,
  YC_ACCESS_KEY_ID,
  YC_SECRET_ACCESS_KEY,
  INTAKE_SECRET,
  BOT_TOKEN,
  CHAT_IDS,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
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

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:algatours@yahoo.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const TYPE_LABEL = {
  excursion: 'Морская экскурсия', resort: 'Выезд на резорт', hotel: 'Бронирование отеля',
  author: 'Авторский тур', diving: 'Дайвинг', sport: 'Активный спорт',
};

// ── парсинг тела запроса (form-urlencoded или JSON) ─────────────────
function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  const ct = ((event.headers && (event.headers['Content-Type'] || event.headers['content-type'])) || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  const out = {};
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

// ── приведение полей формы к единой схеме заявки ────────────────────
function normalize(d) {
  const t = d.service_type || 'excursion';
  const b = {
    id: crypto.randomUUID(),
    created_ts: Date.now(),
    status: 'new',
    notified: false,
    notify_attempts: 0,
    service_type: t,
    fio: (d.fio || '').trim(),
    phone: (d.phone || '').trim(),
    island: (d.departure_island || '').trim(),
    transfer: d.private_transfer ? 'Да' : '',
    notes: (d.important_notes || '').trim(),
    service: '', people: '', guests: '', date1: '', date2: '',
  };
  if (t === 'excursion') { b.service = d.excursion; b.date1 = d.excursion_date; b.people = d.people_count; }
  else if (t === 'resort') { b.service = d.resort_excursion; b.date1 = d.resort_date; b.people = d.resort_people_count; }
  else if (t === 'hotel') { b.service = d.hotel_booking; b.date1 = d.check_in_date; b.date2 = d.check_out_date; b.people = d.room_count; b.guests = d.hotel_guests; }
  else if (t === 'author') { b.service = d.author_tour; b.date1 = d.author_date_start; b.date2 = d.author_date_end; b.people = d.author_people_count; }
  else if (t === 'diving') { b.service = 'Дайвинг'; b.date1 = d.diving_date; b.people = d.diving_people_count; }
  else if (t === 'sport') { b.service = 'Активный спорт'; b.date1 = d.sport_date; b.people = d.sport_people_count; }
  b.service = (b.service || '').trim();
  b.people = (b.people || '').toString().trim();
  b.guests = (b.guests || '').toString().trim();
  b.received = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Indian/Maldives', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  return b;
}

const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : (s || ''); };

// ── Telegram ────────────────────────────────────────────────────────
function tgSend(text) {
  if (!BOT_TOKEN || !CHAT_IDS) return Promise.resolve();
  const chats = CHAT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  return Promise.all(chats.map((chat_id) => new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { if (res.statusCode !== 200) console.error('tg http', res.statusCode, d.slice(0, 200)); resolve(); }); });
    req.setTimeout(8000, () => { console.error('tg timeout'); req.destroy(); });
    req.on('error', (e) => { console.error('tg error', e.message); resolve(); });
    req.write(payload); req.end();
  })));
}

function tgMessage(b) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const L = [];
  L.push(`🔔 <b>Новая заявка ALGA</b>`);
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
  if (b.transfer) L.push(`🚗 Приватный трансфер: да`);
  if (b.notes) L.push(`📝 ${esc(b.notes)}`);
  L.push('');
  L.push(`🕒 ${esc(b.received)}`);
  return L.join('\n');
}

// ── Web Push всем подписанным админам ───────────────────────────────
async function pushAll(b) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  let subs = [];
  try {
    const res = await ddb.send(new ScanCommand({ TableName: SUBS_TABLE }));
    subs = res.Items || [];
  } catch (e) { console.error('scan subs', e.message); return; }
  const payload = JSON.stringify({
    title: '🔔 Новая заявка ALGA',
    body: `${b.fio || 'Без имени'} · ${TYPE_LABEL[b.service_type] || ''} · ${b.phone || ''}`,
  });
  await Promise.all(subs.map(async (row) => {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { const { DeleteCommand } = require('@aws-sdk/lib-dynamodb'); await ddb.send(new DeleteCommand({ TableName: SUBS_TABLE, Key: { endpoint: row.endpoint } })); } catch (_) {}
      } else { console.error('push', e.statusCode || e.message); }
    }
  }));
}

// ── handler ─────────────────────────────────────────────────────────
const OK_HTML = '<!doctype html><html><body>OK</body></html>';
const html = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body });

module.exports.handler = async (event) => {
  const method = (event.httpMethod || 'POST').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  if (method !== 'POST') return html(405, 'Method Not Allowed');

  let d;
  try { d = parseBody(event); } catch (e) { return html(400, 'Bad Request'); }

  // проверка секретного ключа формы
  if (!INTAKE_SECRET || d.key !== INTAKE_SECRET) return html(403, 'Forbidden');

  // honeypot: заполнено скрытое поле — тихо игнорируем (притворяемся успехом)
  if (d.company) return html(200, OK_HTML);

  if (!(d.fio || '').trim() || !(d.phone || '').trim()) return html(400, 'Bad Request');

  const b = normalize(d);

  try {
    await ddb.send(new PutCommand({ TableName: BOOKINGS_TABLE, Item: b }));
  } catch (e) {
    console.error('put booking', e.message);
    return html(500, 'DB error');
  }

  // Уведомления (Telegram + Web Push) НЕ шлём здесь — они вынесены в
  // отдельную функцию alga-notify (таймер раз в минуту, с повторами).
  // Так форма всегда получает быстрый 200, а нестабильность исходящих
  // запросов из Yandex Cloud не роняет ответ и не теряет уведомления.
  return html(200, OK_HTML);
};
