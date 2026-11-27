// Reading a public events calendar page (a venue's "Schedule" or "Events" page) into a list of events, for
// "Import from a calendar page" (Settings → Programming) and Ask ShiftBoard's read_events_calendar tool. Nothing here
// saves anything: core/calendar-import.js turns the events into programming and event suggestions.
//
// Fetching someone else's URL from our server is an SSRF risk, so every request (and every redirect, at most 3) is:
//   - http or https only (webcal:// is read as https://), no user:password@ in the URL, ports 80/443/8080/8443 only;
//   - to a host whose every DNS address is public: loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7),
//     link-local (169.254/16 incl. the cloud metadata address, fe80::/10), CGNAT, multicast and reserved are refused.
//     The real transport checks again at connect time (its own DNS lookup), so a name can't switch to a private
//     address between the check and the connection (DNS rebinding);
//   - 10 s per request, at most 2 MB read, and only text/html, application/json, application/ld+json, text/calendar
//     (or text/plain for .ics files) are read; a plain user agent with nothing about the person or the restaurant.
// Tests (and the local UI check) pass their own transport and/or `allowHosts`; the server never takes allowHosts
// from the environment or a request.
//
// Where the events come from, first that works:
//   1. The Events Calendar (WordPress "tribe-events"): its REST API, /wp-json/tribe/events/v1/events, for the next
//      8 weeks (a few pages at most);
//   2. iCal feeds the page links to (.ics, ?ical=1, webcal://): VEVENTs with simple RRULEs (weekly/daily, BYDAY,
//      INTERVAL, UNTIL, COUNT, EXDATE) expanded over the window;
//   3. schema.org Event / EventSeries in JSON-LD blocks;
//   4. the page's text read by AI (purpose 'import_calendar', strict JSON, counted toward the restaurant's cap).
// Each event: { title, date, start, end, room, description, url, categories, uid, recurrence? }, times in the
// venue's own clock (HH:MM, '' = not given).
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const WEEKS = 8;
export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
export const MAX_EVENTS = 400;
const USER_AGENT = 'ShiftBoard-CalendarReader/1.0 (+events calendar import)';
const TYPES = ['text/html', 'application/json', 'application/ld+json', 'text/calendar', 'application/xhtml+xml'];
const PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_AI_TEXT = 30_000;

export class CalendarError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.status = 400; }
}
const ERR = {
  url: 'That doesn’t look like a web page address. Paste the full link, like https://example.com/events.',
  scheme: 'Only http and https pages can be read.',
  blocked: 'That address points to a private or internal network, so ShiftBoard won’t read it.',
  dns: 'That website couldn’t be found. Check the address.',
  timeout: 'The page took too long to answer. Try again in a minute.',
  tooBig: 'That page is too large to read.',
  type: 'That link isn’t a web page or calendar ShiftBoard can read.',
  status: 'The page didn’t load (it answered with an error).',
  redirects: 'The page redirected too many times.',
  network: 'The page couldn’t be reached. Check the address and try again.',
  none: 'No events were found on that page.',
};
const ERR_ES = {
  url: 'Eso no parece la dirección de una página web. Pega el enlace completo, como https://example.com/events.',
  scheme: 'Solo se pueden leer páginas http y https.',
  blocked: 'Esa dirección apunta a una red privada o interna, así que ShiftBoard no la va a leer.',
  dns: 'No se encontró ese sitio web. Revisa la dirección.',
  timeout: 'La página tardó demasiado en responder. Inténtalo de nuevo en un minuto.',
  tooBig: 'Esa página es demasiado grande para leerla.',
  type: 'Ese enlace no es una página web ni un calendario que ShiftBoard pueda leer.',
  status: 'La página no cargó (respondió con un error).',
  redirects: 'La página redirigió demasiadas veces.',
  network: 'No se pudo llegar a la página. Revisa la dirección e inténtalo de nuevo.',
  none: 'No se encontraron eventos en esa página.',
  noUrl: 'Pega primero el enlace de la página del calendario.',
};
ERR.noUrl = 'Paste the calendar page’s link first.';
/** A reader error in the person's language. */
export const calendarErrorText = (code, lang = 'en') => (lang === 'es' ? ERR_ES : ERR)[code] || ERR.network;
const fail = (code) => { throw new CalendarError(code, ERR[code]); };

// ---------- the SSRF guard ----------

const v4 = (ip) => ip.split('.').map(Number);
/** Is this IP address one we must never connect to? */
export function isBlockedIp(ip) {
  let a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [x, y] = v4(a);
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
      || (x === 100 && y >= 64 && y <= 127) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
  }
  if (net.isIPv6(a)) {
    if (a === '::' || a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // unique local
    if ((first & 0xffc0) === 0xfe80) return true; // link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (/^::ffff:/.test(a) || /^64:ff9b:/.test(a)) return true; // other mapped / NAT64 forms: refuse rather than guess
    return false;
  }
  return true; // not an address at all
}

/** A URL we may fetch (normalized), or a CalendarError. */
export function checkUrl(raw) {
  let s = String(raw || '').trim();
  if (/^webcal:\/\//i.test(s)) s = `https://${s.slice(9)}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { fail('url'); }
  if (!['http:', 'https:'].includes(u.protocol)) fail('scheme');
  if (u.username || u.password) fail('url');
  if (!u.hostname) fail('url');
  u.hash = '';
  return u;
}

const defaultLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Every address of the host is public (or the host is on the test-only allow list). */
async function guardHost(u, { lookup = defaultLookup, allowHosts = null }) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (allowHosts?.has(host.toLowerCase())) return;
  if (!PORTS.has(u.port)) fail('blocked');
  if (net.isIP(host)) { if (isBlockedIp(host)) fail('blocked'); return; }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) fail('blocked');
  let addrs;
  try { addrs = await lookup(host); } catch { fail('dns'); }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (!list.length) fail('dns');
  if (list.some(isBlockedIp)) fail('blocked');
}

/**
 * The real transport: node's http/https with a DNS lookup that refuses private addresses at connect time.
 * → { status, headers: { get(name) }, body: string }; reads at most maxBytes (then tooBig).
 */
export function nodeTransport({ allowHosts = null } = {}) {
  const guardedLookup = (hostname, opts, cb) => {
    dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: opts.family || 4 }];
      if (!allowHosts?.has(String(hostname).toLowerCase()) && list.some((a) => isBlockedIp(a.address))) return cb(Object.assign(new Error('blocked'), { code: 'EBLOCKED' }));
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
  return (url, { signal, maxBytes = MAX_BYTES, headers = {} } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', headers, lookup: guardedLookup, signal, agent: false }, (res) => {
      const type = String(res.headers['content-type'] || '');
      const out = { status: res.statusCode, headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } } };
      if (res.statusCode >= 300 || !okType(type, u.pathname)) { res.resume(); return resolve({ ...out, body: '' }); }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(); reject(new CalendarError('tooBig', ERR.tooBig)); } else chunks.push(c); });
      res.on('end', () => resolve({ ...out, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', (e) => reject(e.code === 'EBLOCKED' || e.cause?.code === 'EBLOCKED' ? new CalendarError('blocked', ERR.blocked) : e));
    req.end();
  });
}

const okType = (type, path = '') => {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  if (TYPES.includes(t)) return true;
  return t === 'text/plain' && /\.ics$/i.test(path); // some servers send .ics files as text/plain
};

/**
 * Fetch a URL safely. o: { transport, lookup, allowHosts (Set of lowercase hostnames, tests only), timeoutMs, maxBytes }.
 * → { url (after redirects), type, body }.
 */
export async function safeFetch(raw, o = {}) {
  const transport = o.transport || nodeTransport({ allowHosts: o.allowHosts });
  let u = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    await guardHost(u, o);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs || TIMEOUT_MS);
    let res;
    try {
      res = await transport(u.href, { signal: ctl.signal, maxBytes: o.maxBytes || MAX_BYTES, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json,application/ld+json,text/calendar;q=0.9,*/*;q=0.1' } });
    } catch (e) {
      if (e instanceof CalendarError) throw e;
      if (ctl.signal.aborted || e.name === 'AbortError') fail('timeout');
      fail('network');
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= MAX_REDIRECTS) fail('redirects');
      const loc = res.headers.get('location');
      if (!loc) fail('status');
      u = checkUrl(new URL(loc, u).href);
      continue;
    }
    if (res.status < 200 || res.status >= 300) fail('status');
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!okType(type, u.pathname)) fail('type');
    const body = typeof res.body === 'string' ? res.body : '';
    if (body.length > (o.maxBytes || MAX_BYTES)) fail('tooBig');
    return { url: u.href, type, body };
  }
}

// ---------- text helpers ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
export const decodeEntities = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});
export const stripHtml = (s) => decodeEntities(String(s ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const clean = (s, max) => stripHtml(s).replace(/\s+/g, ' ').trim().slice(0, max);
const pad = (n) => String(n).padStart(2, '0');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** '2026-03-04T19:30:00-07:00' / '2026-03-04 19:30:00' → { date, time } in the venue's clock (the literal wall time). */
function wall(s, tz = null) {
  if (tz && /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(String(s || ''))) { const ms = Date.parse(s); if (Number.isFinite(ms)) return inZone(ms, tz); }
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  return m ? { date: m[1], time: m[2] ? `${m[2]}:${m[3]}` : '' } : null;
}
/** A UTC instant as the wall time in a time zone. */
function inZone(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function event({ title, start, end, room = '', description = '', url = '', categories = [], uid = '', recurrence = null, allDay = false }) {
  const name = clean(title, 120);
  if (!name || !start?.date || !DATE.test(start.date)) return null;
  return {
    title: name, date: start.date, start: allDay ? '' : start.time || '', end: allDay ? '' : end?.time || '',
    room: clean(room, 120), description: clean(description, 300), url: /^https?:\/\//i.test(String(url || '')) ? String(url).slice(0, 500) : '',
    categories: [...new Set((categories || []).map((c) => clean(c, 40)).filter(Boolean))].slice(0, 5), uid: String(uid || '').slice(0, 200),
    ...(recurrence ? { recurrence } : {}),
  };
}

// ---------- 1. The Events Calendar (tribe) REST API ----------

/** The page is (or links to) The Events Calendar: the API's base URL, else null. */
export function tribeApiBase(html, pageUrl) {
  const u = new URL(pageUrl);
  if (/\/wp-json\/tribe\/events\/v1\//.test(u.pathname)) return `${u.origin}${u.pathname.replace(/(\/wp-json\/tribe\/events\/v1\/).*/, '$1')}`;
  const link = String(html).match(/href=["']([^"']*\/wp-json\/tribe\/events\/v1\/?)["']/i);
  if (link) { try { const l = new URL(decodeEntities(link[1]), u); if (l.origin === u.origin) return l.href.replace(/\/?$/, '/'); } catch { /* ignore */ } }
  if (/tribe-events|tribe_events|wp-json\\?\/tribe\\?\/events/i.test(html)) return `${u.origin}/wp-json/tribe/events/v1/`;
  return null;
}

export function tribeEvents(json) {
  const list = Array.isArray(json?.events) ? json.events : [];
  return list.map((e) => event({
    title: e.title, start: wall(e.start_date), end: wall(e.end_date), allDay: !!e.all_day,
    room: e.venue && !Array.isArray(e.venue) ? e.venue.venue || '' : '', description: e.excerpt || e.description || '', url: e.url,
    categories: (e.categories || []).map((c) => c?.name), uid: e.id != null ? `tribe:${e.id}` : e.url,
  })).filter(Boolean);
}

async function readTribe(base, o, { from, to }) {
  const out = [];
  for (let page = 1; page <= 4; page++) {
    const api = new URL('events', base);
    api.search = new URLSearchParams({ start_date: from, end_date: to, per_page: '50', page: String(page) }).toString();
    let r;
    try { r = await safeFetch(api.href, o); } catch (e) { if (page === 1) throw e; break; }
    let json;
    try { json = JSON.parse(r.body); } catch { if (page === 1) return null; break; }
    out.push(...tribeEvents(json));
    if (!json.next_rest_url && !(json.total_pages > page)) break;
  }
  return out;
}

// ---------- 2. iCal ----------

/** The iCal feeds a page links to (same site first). */
export function icsLinks(html, pageUrl) {
  const u = new URL(pageUrl);
  const out = [];
  for (const m of String(html).matchAll(/(?:href|data-url)=["']([^"']+)["']/gi)) {
    const raw = decodeEntities(m[1]);
    if (!/(\.ics(\?|$)|[?&]ical=1|^webcal:)/i.test(raw) || /google\.com|outlook\.|office\.com|live\.com/i.test(raw)) continue;
    try { const l = new URL(raw.replace(/^webcal:/i, 'https:'), u); if (!out.includes(l.href)) out.push(l.href); } catch { /* ignore */ }
  }
  return out.sort((a, b) => Number(new URL(b).origin === u.origin) - Number(new URL(a).origin === u.origin)).slice(0, 3);
}

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const unescapeIcs = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** An iCal date-time → wall time in the venue's zone. */
function icsTime(value, params, tz) {
  const m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date, time: '', allDay: true };
  if (m[7]) return inZone(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), tz);
  return { date, time: `${m[4]}:${m[5]}` }; // TZID or floating: the venue's own clock
}

/** VEVENTs (with simple RRULEs expanded between from and to). */
export function parseIcs(text, { from, to, tz = 'UTC' } = {}) {
  const lines = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = { exdates: [] }; continue; }
    if (/^END:VEVENT/i.test(line)) { if (cur) out.push(...expandIcs(cur, { from, to, tz })); cur = null; continue; }
    if (!cur) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/i);
    if (!m) continue;
    const [, key, params, value] = m;
    const k = key.toUpperCase();
    if (k === 'EXDATE') cur.exdates.push(...value.split(',').map((v) => icsTime(v, params, tz)?.date).filter(Boolean));
    else cur[k] = { value, params };
    if (out.length > MAX_EVENTS) break;
  }
  return out;
}

function expandIcs(v, { from, to, tz }) {
  if (/CANCELLED/i.test(v.STATUS?.value || '')) return [];
  const start = icsTime(v.DTSTART?.value, v.DTSTART?.params, tz);
  if (!start) return [];
  const end = v.DTEND ? icsTime(v.DTEND.value, v.DTEND.params, tz) : null;
  const base = { title: unescapeIcs(v.SUMMARY?.value), room: unescapeIcs(v.LOCATION?.value), description: unescapeIcs(v.DESCRIPTION?.value), url: v.URL?.value || '',
    categories: unescapeIcs(v.CATEGORIES?.value || '').split(',').map((s) => s.trim()), uid: v.UID?.value || '', allDay: !!start.allDay };
  const rrule = v.RRULE?.value ? Object.fromEntries(v.RRULE.value.split(';').map((p) => p.split('=')).map(([a, b]) => [String(a).toUpperCase(), b || ''])) : null;
  if (!rrule) return [event({ ...base, start, end })].filter(Boolean);
  const freq = rrule.FREQ;
  if (!['WEEKLY', 'DAILY'].includes(freq)) return [event({ ...base, start, end })].filter(Boolean); // monthly/yearly: the first date only
  const interval = Math.max(1, Math.min(4, Number(rrule.INTERVAL) || 1));
  const days = freq === 'DAILY' ? [0, 1, 2, 3, 4, 5, 6] : (rrule.BYDAY ? rrule.BYDAY.split(',').map((d) => BYDAY[d.slice(-2).toUpperCase()]).filter((d) => d != null) : [dowOf(start.date)]);
  const until = rrule.UNTIL ? icsTime(rrule.UNTIL, '', tz)?.date : '';
  const count = Number(rrule.COUNT) || 0;
  const recurrence = { freq: freq === 'DAILY' ? 'daily' : 'weekly', interval, days, until: until || '', count, first: start.date };
  const dates = [];
  const weekOf = (d) => addDays(d, -dowOf(d));
  const anchorWeek = weekOf(start.date);
  let n = 0;
  for (let d = start.date; d <= (until || to) && d <= addDays(start.date, 366 * 2); d = addDays(d, 1)) {
    const weeks = Math.round((Date.parse(weekOf(d)) - Date.parse(anchorWeek)) / (7 * 86_400_000));
    if (freq === 'WEEKLY' ? (weeks % interval !== 0 || !days.includes(dowOf(d))) : (Math.round((Date.parse(d) - Date.parse(start.date)) / 86_400_000) % interval !== 0)) continue;
    n++;
    if (count && n > count) break;
    if (v.exdates.includes(d)) continue;
    if (d >= from && d <= to) dates.push(d);
    if (dates.length > 120) break;
  }
  if (count && !until) recurrence.until = '';
  const last = count ? (() => { let k = 0, d = start.date, lastD = start.date; for (; k < count && d <= addDays(start.date, 366 * 2); d = addDays(d, 1)) { const weeks = Math.round((Date.parse(weekOf(d)) - Date.parse(anchorWeek)) / (7 * 86_400_000)); if (freq === 'WEEKLY' ? (weeks % interval === 0 && days.includes(dowOf(d))) : true) { k++; lastD = d; } } return lastD; })() : '';
  if (last) recurrence.until = last;
  return dates.map((d) => event({ ...base, start: { date: d, time: start.time }, end: end ? { date: d, time: end.time } : null, recurrence })).filter(Boolean);
}

// ---------- 3. JSON-LD ----------

const isEventType = (t) => [].concat(t || []).some((x) => /Event$|^EventSeries$/i.test(String(x)));
export function jsonLdEvents(html, tz = 'UTC') {
  const w = (x) => wall(x, tz);
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object' || out.length > MAX_EVENTS) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node['@graph']) visit(node['@graph']);
    if (isEventType(node['@type'])) {
      const loc = [].concat(node.location || [])[0];
      const series = /EventSeries/i.test([].concat(node['@type']).join(' '));
      const e = event({ title: node.name, start: w(node.startDate), end: w(node.endDate), room: typeof loc === 'string' ? loc : loc?.name || '',
        description: node.description || '', url: node.url || '', uid: node['@id'] || node.url || '',
        categories: [].concat(node.keywords || [], node.genre || []).flatMap((k) => String(k).split(',')).filter(Boolean),
        allDay: /^\d{4}-\d{2}-\d{2}$/.test(String(node.startDate || '')) });
      if (e && !series) out.push(e);
      if (node.subEvent) visit(node.subEvent);
      if (node.eventSchedule && series) {
        // An EventSeries with a schedule: { byDay, startTime, endTime, startDate, endDate }.
        for (const s of [].concat(node.eventSchedule)) {
          const days = [].concat(s.byDay || []).map((d) => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(String(d).split('/').pop().toLowerCase())).filter((d) => d >= 0);
          if (!days.length) continue;
          out.push({ ...(e || event({ title: node.name, start: w(s.startDate || node.startDate) })), seriesOnly: true,
            start: String(s.startTime || '').slice(0, 5), end: String(s.endTime || '').slice(0, 5), date: w(s.startDate || node.startDate)?.date || '',
            recurrence: { freq: 'weekly', interval: 1, days, until: w(s.endDate || node.endDate)?.date || '', count: 0, first: w(s.startDate || node.startDate)?.date || '' } });
        }
      }
    }
  };
  for (const m of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* a broken block: skip it */ }
  }
  return out.filter((e) => e && (e.date || e.seriesOnly));
}

// ---------- 4. AI ----------

export const AI_SYSTEM = [
  'You read the text of a venue\'s public events calendar page and list its events.',
  'Answer with one JSON object and nothing else: { "events": [ { "title": string, "date": "YYYY-MM-DD", "start": "HH:MM" or "", "end": "HH:MM" or "", "room": string (the room, stage or space named for it, or ""), "description": string (one short sentence or ""), "weekly": boolean (true only when the page says it happens every week) } ] }.',
  'Use 24-hour times in the venue\'s own clock. Use only dates the page states (resolve "Fri Dec 4" with the year given on the page or the next such date after today). Never invent events, times or rooms. If there are no events, answer { "events": [] }.',
].join('\n');

export function aiEvents(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i < 0 || j < i) return [];
  try { raw = JSON.parse(raw.slice(i, j + 1)); } catch { return []; }
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  return (Array.isArray(raw?.events) ? raw.events : []).slice(0, MAX_EVENTS).map((e) => event({
    title: e?.title, start: { date: String(e?.date || ''), time: TIME.test(e?.start) ? e.start : '' }, end: { time: TIME.test(e?.end) ? e.end : '' },
    room: e?.room || '', description: e?.description || '',
  })).filter(Boolean);
}

// ---------- the reader ----------

/**
 * Read a calendar page. o: { today: 'YYYY-MM-DD', tz, weeks, transport, lookup, allowHosts, ai (aiFor(...) or null), user }.
 * → { url, source: 'tribe' | 'ics' | 'jsonld' | 'ai', from, to, events, notes: [codes] }.
 */
export async function readCalendarPage(rawUrl, o = {}) {
  const today = DATE.test(String(o.today || '')) ? o.today : new Date().toISOString().slice(0, 10);
  const from = today;
  const to = addDays(today, 7 * (o.weeks || WEEKS));
  const tz = o.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const page = await safeFetch(rawUrl, o);
  const notes = [];
  const within = (list) => list.filter((e) => e.seriesOnly || (e.date >= from && e.date <= to)).slice(0, MAX_EVENTS);
  const done = (source, events) => ({ url: page.url, source, from, to, events: within(events).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)), notes });

  // The link itself is a feed.
  if (page.type === 'text/calendar' || /^BEGIN:VCALENDAR/m.test(page.body.slice(0, 200))) return done('ics', parseIcs(page.body, { from, to, tz }));
  if (/json/.test(page.type)) {
    let json = null;
    try { json = JSON.parse(page.body); } catch { /* not JSON after all */ }
    if (json?.events) return done('tribe', tribeEvents(json));
    if (json) return done('jsonld', jsonLdEvents(`<script type="application/ld+json">${page.body}</script>`, tz));
  }
  const html = page.body;

  const base = tribeApiBase(html, page.url);
  if (base) {
    try {
      const list = await readTribe(base, o, { from, to });
      if (list?.length) return done('tribe', list);
    } catch (e) { if (e.code === 'blocked') throw e; notes.push('tribeFailed'); }
  }
  for (const link of icsLinks(html, page.url)) {
    try {
      const feed = await safeFetch(link, o);
      const list = parseIcs(feed.body, { from, to, tz });
      if (within(list).length) return done('ics', list);
    } catch (e) { if (e.code === 'blocked') throw e; notes.push('icsFailed'); }
  }
  const ld = jsonLdEvents(html, tz);
  if (within(ld).length) return done('jsonld', ld);

  const ai = o.ai;
  if (ai && ai.available) {
    const text = stripHtml(html).slice(0, MAX_AI_TEXT);
    if (text.trim()) {
      let r = null;
      try {
        r = await ai.complete({ purpose: 'import_calendar', system: AI_SYSTEM, maxTokens: 6000, user: o.user || null,
          messages: [{ role: 'user', content: `Today is ${today}. The page ${page.url} says:\n\n${text}\n\nList its events. JSON only.` }] });
      } catch (e) { notes.push(`ai_${e.reason || 'api'}`); }
      const list = aiEvents(r?.text);
      if (within(list).length) return done('ai', list);
    }
  } else notes.push(ai ? `ai_${ai.reason || 'off'}` : 'ai_off');
  throw Object.assign(new CalendarError('none', ERR.none), { notes });
}
