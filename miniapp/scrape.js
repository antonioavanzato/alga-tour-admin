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

function tourDates(html) {
  const t = clean(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ''));
  const re = /(\d{1,2})\.(\d{2})\s*[—–-]\s*(\d{1,2})\.(\d{2})\.(\d{2})/g;
  const seen = new Set(); const out = []; let m;
  while ((m = re.exec(t))) {
    const yEnd = 2000 + +m[5];
    const yStart = +m[2] > +m[4] ? yEnd - 1 : yEnd;
    const start = `${yStart}-${m[2]}-${m[1].padStart(2, '0')}`;
    const end = `${yEnd}-${m[4]}-${m[3].padStart(2, '0')}`;
    if (!seen.has(start)) { seen.add(start); out.push({ start, end }); }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

async function lang(prefix) {
  const [exc, hot, tours] = await Promise.all(['/ekskursii', '/bron-oteley', '/avtorskie-tury'].map((p) => get(prefix + p)));
  const e = cards(exc), h = cards(hot);
  if (e.length < 3 || h.length < 3) throw new Error(`${prefix || 'ru'}: мало карточек (${e.length}/${h.length})`);
  return { excursions: e, hotels: h, tours: { url: `${BASE}${prefix}/avtorskie-tury`, dates: tourDates(tours) } };
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
