// Раз в сутки собирает актуальные карточки с alga-tour.com в data.json (RU и EN).
// Если сайт недоступен, старый data.json остаётся как есть.
'use strict';
const fs = require('fs');
const path = require('path');
const BASE = 'https://alga-tour.com';
const OUT = path.join(__dirname, 'data.json');
const LOCAL = process.argv[2]; // папка с сохранёнными страницами для проверки без сети

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

async function get(p) {
  if (LOCAL) return fs.readFileSync(path.join(LOCAL, (p.replace(/^\//, '').replace('/', '_') || 'index') + '.html'), 'utf8');
  const r = await fetch(BASE + p, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36', 'Accept-Language': 'ru,en' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.text();
}

function cards(html) {
  const out = [];
  const re = /<a class="card[^"]*" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const b = m[2];
    const title = clean((/<h3>([\s\S]*?)<\/h3>/.exec(b) || [])[1]);
    if (!title) continue;
    const price = (/<span class="price">[\s\S]*?(\$\s?\d[\d\s]*)/.exec(b) || [])[1];
    out.push({
      title,
      label: clean((/<div class="label">[\s\S]*?<span>([\s\S]*?)<\/span>/.exec(b) || [])[1]),
      text: clean((/<p>([\s\S]*?)<\/p>/.exec(b) || [])[1]),
      price: price ? price.replace(/\s/g, '') : '',
      img: (/<img src="([^"]+)"/.exec(b) || [])[1] || '',
      url: BASE + m[1],
    });
  }
  return out;
}

// Даты авторского тура из текста страницы. Понимает почти любую запись Кати:
//  30.12 — 6.01.27 · 30.12.26 – 06.01.27 · 30.12.2026-06.01.2027 · 30/12 - 6/1/2027 · 1.5 — 8.5
//  30 декабря — 6 января 2027 · с 30 декабря по 6 января · 1–8 мая 2027 · 1 - 8.05.27
//  Dec 30 – Jan 6, 2027 · 30 December - 6 January 2027 · May 1–8
// Год можно не писать: берётся ближайший будущий (тур, начавшийся до 60 дней назад, — этот год).
function tourDatesFrom(text, now) {
  now = now || new Date();
  var MON = { 'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'мая': 5, 'май': 5, 'июн': 6, 'июл': 7, 'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12 };
  var t = ' ' + String(text).toLowerCase()
    .replace(/&nbsp;|&#160;| /g, ' ').replace(/&mdash;|&ndash;|&#8212;|&#8211;|—|–|−/g, '-')
    .replace(/(\d)\s*[\/\\]\s*(?=\d)/g, '$1.')
    .replace(/(\d)\s*г(ода|\.)?(?![а-я])/g, '$1')
    .replace(/\s+/g, ' ') + ' ';
  var MR = '(янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-zа-яё]*\\.?';
  t = t.replace(new RegExp('(^|[^a-zа-яё])' + MR + ' (\\d{1,2})(?:st|nd|rd|th)?(?![\\d.])', 'g'), function (_, a, m, d) { return a + d + ' ' + m; });
  t = t.replace(new RegExp('(?<![\\d.])(\\d{1,2})(?:st|nd|rd|th)?\\s*' + MR, 'g'), function (_, d, m) { return d + '.' + MON[m]; });
  t = t.replace(/(\d{1,2}\.\d{1,2}),?\s+(20\d{2})(?!\d)/g, '$1.$2');
  var D = '(\\d{1,2})', DM = '(\\d{1,2})(?:\\.(\\d{1,2}))?(?:\\.(\\d{4}|\\d{2}))?';
  var SEP = '\\s*(?:-|по|до|to|till|until|through)\\s*';
  var re = new RegExp('(?:^|[^\\d.])(?:с\\s+|from\\s+)?' + DM + SEP + D + '(?:\\.(\\d{1,2}))?(?:\\.(\\d{4}|\\d{2}))?(?![\\d])', 'g');
  var p2 = function (x) { return ('0' + x).slice(-2); };
  var Y = function (y) { return y.length === 2 ? 2000 + +y : +y; };
  var ok = function (d, m) { return m >= 1 && m <= 12 && d >= 1 && d <= 31; };
  var limit = new Date(now.getTime() - 60 * 864e5), seen = {}, out = [], m;
  while ((m = re.exec(t))) {
    if (!m[2] && !m[5]) continue;
    var d1 = +m[1], m1 = m[2] ? +m[2] : +m[5], d2 = +m[4], m2 = m[5] ? +m[5] : m1;
    if ((!m[2] || !m[5]) && d1 > d2) continue;
    if (!ok(d1, m1) || !ok(d2, m2)) continue;
    var yEnd, yStart;
    if (m[6]) { yEnd = Y(m[6]); yStart = m[3] ? Y(m[3]) : (m1 > m2 ? yEnd - 1 : yEnd); }
    else if (m[3]) { yStart = Y(m[3]); yEnd = m1 > m2 ? yStart + 1 : yStart; }
    else {
      yStart = now.getFullYear();
      if (new Date(yStart, m1 - 1, d1) < limit) yStart++;
      yEnd = m1 > m2 ? yStart + 1 : yStart;
    }
    var start = yStart + '-' + p2(m1) + '-' + p2(d1), end = yEnd + '-' + p2(m2) + '-' + p2(d2);
    var days = (new Date(end) - new Date(start)) / 864e5;
    if (!(days >= 0 && days <= 60) || seen[start]) continue;
    seen[start] = 1; out.push({ start: start, end: end });
  }
  return out.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
}

function tourDates(html) {
  return tourDatesFrom(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

async function lang(prefix) {
  const [exc, hot, tours] = await Promise.all(['/ekskursii', '/bron-oteley', '/avtorskie-tury'].map((p) => get(prefix + p)));
  const e = cards(exc), h = cards(hot);
  const td = tourDates(tours);
  if (!td.length) throw new Error(`${prefix || 'ru'}: не найдено ни одной даты тура`);
  if (e.length < 3 || h.length < 3) throw new Error(`${prefix || 'ru'}: мало карточек (${e.length}/${h.length})`);
  return { excursions: e, hotels: h, tours: { url: `${BASE}${prefix}/avtorskie-tury`, dates: td } };
}

(async () => {
  try {
    const data = { updated: new Date().toISOString(), ru: await lang(''), en: await lang('/en') };
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
    console.log(`ok: ${data.ru.excursions.length} экскурсий, ${data.ru.hotels.length} отелей, ${data.ru.tours.dates.length} дат тура`);
  } catch (e) {
    console.error('Не обновлено, оставлен прежний data.json:', e.message);
  }
})();
