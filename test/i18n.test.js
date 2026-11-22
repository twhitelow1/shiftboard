// English and Spanish: the web catalogs, the language each person gets, and the text the server writes
// (notifications, conflicts, emails, texts, errors) in each recipient's language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { langOf, formatStamp } from '../core/i18n.js';
import { prettyDate, fmtTime, dayName } from '../core/time.js';
import { translateError, ERRORS_ES } from '../core/errors.js';
import { welcomeText, textMessage } from '../core/notify-prefs.js';
import { describePool, explainShare, normalizePool, exampleSplit, periodLabel } from '../core/tips.js';
import { notificationEmail, inviteEmail, resetEmail, testEmail } from '../server/email.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import en from '../web/src/i18n/en.js';
import es from '../web/src/i18n/es.js';
import { translate } from '../web/src/i18n/index.js';
import { STRINGS as TRAINING } from '../web/src/training-strings.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- the web catalogs ----------
const isForms = (v) => v && typeof v === 'object' && typeof v.other === 'string';
function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || isForms(v)) out[key] = v;
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}
const EN = flatten(en);
const ES = flatten(es);
const placeholders = (v) => new Set([...(isForms(v) ? Object.values(v) : [v]).join(' ').matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

test('every English key has a Spanish translation, and the other way round', () => {
  const missing = Object.keys(EN).filter((k) => !(k in ES));
  const extra = Object.keys(ES).filter((k) => !(k in EN));
  assert.deepEqual(missing, [], 'missing in es.js');
  assert.deepEqual(extra, [], 'in es.js but not en.js');
  for (const [k, v] of Object.entries(EN)) {
    assert.ok(typeof ES[k] === 'string' || isForms(ES[k]), `${k}: Spanish is not text`);
    if (isForms(v)) assert.ok(isForms(ES[k]), `${k}: English has plural forms, Spanish needs them too`);
    // Spanish can leave out a placeholder English needs (like {article}), but never invent one.
    const extraParams = [...placeholders(ES[k])].filter((p) => !placeholders(v).has(p));
    assert.deepEqual(extraParams, [], `${k}: placeholders only Spanish uses`);
    if (isForms(ES[k])) assert.ok(ES[k].one && ES[k].other, `${k}: needs one and other`);
  }
});

test('Training’s own words have the same keys in English and Spanish', () => {
  const keys = (o) => Object.keys(flatten(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? 'fn' : v])))).sort();
  assert.deepEqual(keys(TRAINING.es), keys(TRAINING.en));
  for (const [k, v] of Object.entries(TRAINING.en)) if (typeof v === 'function') assert.equal(typeof TRAINING.es[k], 'function', k);
});

// Every key the web app asks for exists: t('…'), tx('…'), tr('…') calls, keys kept in constants ('swaps.typeSwap'),
// and keys built with a template (t(`settings.theme_${id}`)) must match at least one catalog key.
// API methods ('swaps.accept') look like keys; they're listed in core/ as 'ns.method': (actor…
const METHODS = new Set(fs.readdirSync(path.join(ROOT, 'core')).flatMap((f) => [...fs.readFileSync(path.join(ROOT, 'core', f), 'utf8').matchAll(/'([a-zA-Z]+\.[a-zA-Z.]+)':\s*\(/g)].map((m) => m[1])));
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sourceFiles(path.join(dir, d.name)) : /\.(jsx?|mjs)$/.test(d.name) ? [path.join(dir, d.name)] : []));
}
test('every catalog key used in web/src exists in en.js', () => {
  const namespaces = new Set(Object.keys(en));
  const problems = [];
  let used = 0;
  for (const file of sourceFiles(path.join(ROOT, 'web/src')).filter((f) => !f.includes(`${path.sep}i18n${path.sep}`))) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const m of src.matchAll(/\b(?:t|tx|tr)\(\s*'([^']+)'/g)) { used++; if (!(m[1] in EN)) problems.push(`${rel}: ${m[1]}`); }
    for (const m of src.matchAll(/\b(?:t|tx|tr)\(\s*`([^`$]*)\$\{/g)) { used++; if (!Object.keys(EN).some((k) => k.startsWith(m[1]))) problems.push(`${rel}: ${m[1]}…`); }
    for (const m of src.matchAll(/'([a-z][A-Za-z]+\.[a-z][A-Za-z0-9_]*)'/g)) {
      if (METHODS.has(m[1])) continue; // an API method, not a key
      if (namespaces.has(m[1].split('.')[0]) && !(m[1] in EN)) problems.push(`${rel}: ${m[1]}`);
    }
  }
  assert.ok(used > 900, `found ${used} uses`);
  assert.deepEqual(problems, []);
});

test('t(): plurals, placeholders, bold markup and English fallback', () => {
  assert.equal(translate('en', 'schedule.deleteCountShifts', { count: 1 }), 'Delete 1 shift');
  assert.equal(translate('en', 'schedule.deleteCountShifts', { count: 3 }), 'Delete 3 shifts');
  assert.equal(translate('es', 'schedule.deleteCountShifts', { count: 1 }), 'Borrar 1 turno');
  assert.equal(translate('es', 'schedule.deleteCountShifts', { count: 3 }), 'Borrar 3 turnos');
  assert.equal(translate('es', 'common.editName', { name: 'Ana' }), 'Editar Ana');
  assert.equal(translate('es', 'no.such.key'), 'no.such.key');
  const rich = translate('es', 'tradeHint.cantMakeOneOfYour');
  assert.equal(typeof rich, 'object', 'a sentence with <b> comes back as a React element');
  assert.equal(translate('es', 'lang.change'), 'Cambiar idioma');
  assert.equal(translate('en', 'lang.change'), 'Change language');
});

// ---------- dates and times ----------
test('dates and times in Spanish, English unchanged', () => {
  assert.equal(prettyDate('2026-12-24'), 'Thu, Dec 24');
  assert.equal(prettyDate('2026-12-24', { dow: false }), 'Dec 24');
  assert.match(prettyDate('2026-12-24', { lang: 'es' }), /^jue,? 24 (de )?dic\.?$/);
  assert.equal(fmtTime('16:00'), '4p');
  assert.equal(fmtTime('16:30', 'es'), '4:30 pm');
  assert.equal(fmtTime('09:00', 'es'), '9 am');
  assert.equal(dayName(3, 'long', 'es'), 'miércoles');
  assert.match(formatStamp('es', '2026-12-24T16:30:00'), /24/);
});

// ---------- whose language ----------
function setup() {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T10:00:00') });
  const u = (name) => store.get('users', ids.userId[name]);
  return { store, svc, ids, u };
}

test('language preference: saved on the account, restaurant default for people who haven’t picked', () => {
  const { svc, u, store, ids } = setup();
  const alex = ids.userId['Alex D'];
  assert.equal(svc.langOf(u('Alex D')), 'en');
  assert.equal(svc.call(u('Alex D'), 'account.preferences', { language: 'es' }).language, 'es');
  assert.equal(store.get('users', alex).language, 'es');
  assert.equal(svc.call(u('Alex D'), 'account.preferences', { language: 'fr' }).language, '', 'anything else means automatic');
  // The restaurant's default (Settings): admins only, auto / en / es.
  assert.throws(() => svc.call(u('Alex D'), 'settings.update', { language: 'es' }), /Admins only/);
  assert.equal(svc.call(u('Moe'), 'settings.update', { language: 'es' }).language, 'es');
  assert.equal(svc.langOf(u('Alex D')), 'es', 'no choice of their own: the restaurant’s');
  svc.call(u('Alex D'), 'account.preferences', { language: 'en' });
  assert.equal(svc.langOf(u('Alex D')), 'en', 'their own choice wins');
  assert.equal(svc.call(u('Moe'), 'settings.update', { language: 'xx' }).language, 'auto');
  assert.equal(svc.call(u('Moe'), 'app.bootstrap').settings.language, 'auto');
  assert.equal(langOf({ language: '' }, { language: 'auto' }), 'en', 'the server falls back to English');
  assert.equal(langOf(null, { language: 'es' }), 'es');
});

// ---------- notifications ----------
test('notifications come out in each recipient’s language, and follow a later language change', () => {
  const { svc, u, store, ids } = setup();
  svc.call(u('Alex D'), 'account.preferences', { language: 'es' });
  let seen = new Set(store.list('notifications').map((n) => n.id));
  // The newest notification for someone (the clock is fixed, so by what's new since last time).
  const mine = (name) => {
    const fresh = store.list('notifications', (n) => n.userId === ids.userId[name] && !seen.has(n.id));
    seen = new Set(store.list('notifications').map((n) => n.id));
    return fresh.at(-1);
  };
  const s = svc.call(u('Moe'), 'shifts.save', { date: '2026-10-06', start: '16:00', jobCodeId: ids.jobId.SRV, userId: ids.userId['Alex D'], published: true }).shift;
  const note = mine('Alex D');
  assert.match(note.text, /^Turno nuevo: .+ mar,? 6 (de )?oct\.? · 4 pm–cierre$/, note.text);
  assert.ok(note.i18n.en.startsWith('New shift: '), 'both versions are kept');
  // Approvers get theirs in English, with the same shift (pickup request by an English speaker).
  svc.call(u('Moe'), 'shifts.save', { id: s.id, date: s.date, start: s.start, jobCodeId: s.jobCodeId, userId: null });
  const removed = mine('Alex D');
  assert.match(removed.text, /^Te quitaron de este turno: /);
  // Reading the list after switching to English shows the English version.
  svc.call(u('Alex D'), 'account.preferences', { language: 'en' });
  const listed = svc.call(u('Alex D'), 'notifications.list').find((n) => n.id === removed.id);
  assert.match(listed.text, /^You were removed from /);
  assert.ok(!('i18n' in listed));
});

test('English notifications are word for word what they were', () => {
  const { svc, u, store, ids } = setup();
  svc.call(u('Moe'), 'shifts.save', { date: '2026-10-06', start: '16:00', end: '22:00', jobCodeId: ids.jobId.SRV, userId: ids.userId['Alex D'], published: true });
  const n = store.list('notifications', (x) => x.userId === ids.userId['Alex D']).at(-1);
  assert.equal(n.text, `New shift: ${store.get('jobCodes', ids.jobId.SRV).name} Tue, Oct 6 4p–10p`);
});

test('trade, time off and publish notifications per language; the restaurant default applies', () => {
  const { svc, u, store, ids } = setup();
  svc.call(u('Moe'), 'settings.update', { language: 'es' }); // nobody picked: everyone gets Spanish
  svc.call(u('Moe'), 'account.preferences', { language: 'en' }); // except Moe
  const t = svc.call(u('Alex D'), 'timeOff.create', { startDate: '2026-11-10', endDate: '2026-11-12', reason: 'Viaje' });
  const toMoe = store.list('notifications', (n) => n.userId === ids.userId.Moe).at(-1);
  assert.match(toMoe.text, /^Alex D requested off Tue, Nov 10 – Thu, Nov 12$/);
  svc.call(u('Moe'), 'timeOff.decide', { id: t.id, status: 'approved' });
  const toAlex = store.list('notifications', (n) => n.userId === ids.userId['Alex D']).at(-1);
  assert.match(toAlex.text, /^Se aprobó tu solicitud de día libre: mar,? 10 (de )?nov\.? – jue,? 12 (de )?nov\.?\.$/, toAlex.text);
  svc.call(u('Moe'), 'shifts.save', { date: '2026-11-17', start: '16:00', jobCodeId: ids.jobId.SRV, userId: null });
  svc.call(u('Moe'), 'shifts.publish', { start: '2026-11-16', end: '2026-11-22' });
  const open = store.list('notifications', (n) => n.text.includes('disponible para recoger'));
  assert.ok(open.length && open.every((n) => n.text === 'Hay 1 turno disponible para recoger.'));
});

test('conflict warnings and conflict errors are in the reader’s language', () => {
  const { svc, u, ids } = setup();
  svc.call(u('Moe'), 'account.preferences', { language: 'es' });
  const shift = { date: '2026-10-07', start: '16:00', end: '22:00', jobCodeId: ids.jobId.SRV, userId: ids.userId['Alex D'] };
  const first = svc.call(u('Moe'), 'shifts.save', shift).shift;
  const { warnings } = svc.call(u('Moe'), 'shifts.save', { ...shift, start: '17:00' });
  assert.ok(warnings.some((w) => /^Se cruza con .+ mié,? 7 (de )?oct\.? · 4 pm–10 pm$/.test(w)), warnings.join(' | '));
  svc.call(u('Moe'), 'account.preferences', { language: 'en' });
  const again = svc.call(u('Moe'), 'shifts.save', { ...shift, start: '18:00' }).warnings;
  assert.ok(again.some((w) => /^Overlaps .+ Wed, Oct 7 4p–10p$/.test(w)), again.join(' | '));
  svc.call(u('Moe'), 'account.preferences', { language: 'es' });
  const eligible = svc.call(u('Moe'), 'shifts.eligible', { shiftId: first.id });
  const listed = svc.call(u('Moe'), 'shifts.list', { start: '2026-10-07', end: '2026-10-07' }).warnings[first.id];
  assert.ok(listed.some((w) => /^Se cruza con /.test(w)), String(listed));
  for (const e of eligible) for (const c of e.conflicts) assert.doesNotMatch(c, /^(Overlaps|Overtime|Approved time off|Available)/);
});

// ---------- texts, emails, push ----------
test('the welcome text in Spanish keeps STOP and HELP in English', () => {
  const es = welcomeText({ restaurant: 'Chasing Rabbits', url: 'https://x.co', lang: 'es' });
  assert.match(es, /Responde STOP para dejar de recibir mensajes, HELP para ayuda\./);
  assert.ok(es.startsWith('Chasing Rabbits: Recibirás mensajes'));
  assert.equal(welcomeText({ restaurant: 'Chasing Rabbits' }), "Chasing Rabbits: You'll get texts about your schedule, trades and time off. Msg & data rates may apply. Reply STOP to opt out, HELP for help.");
  assert.match(textMessage({ restaurant: 'R', text: 'Turno nuevo', more: 2, lang: 'es' }), /\(\+2 más\)$/);
  assert.match(textMessage({ restaurant: 'R', text: 'New shift', more: 2 }), /\(\+2 more\)$/);
});

test('emails in the recipient’s language', () => {
  const user = { name: 'Ana López', email: 'ana@rabbits.co' };
  const n = notificationEmail({ user, note: { text: 'Turno nuevo: Server mar, 6 de oct · 4 pm–cierre', link: '#/my' }, appUrl: 'https://s.co', restaurant: 'Rabbits', lang: 'es' });
  assert.match(n.text, /^Hola, Ana:/);
  assert.match(n.html, /<html lang="es">/);
  assert.match(n.text, /Abrir ShiftBoard: https:\/\/s\.co\/#\/my/);
  assert.match(n.text, /apaga las notificaciones por correo/);
  const inv = inviteEmail({ user, link: 'https://s.co/#/reset?token=x', restaurant: 'Rabbits', invitedBy: 'Moe', lang: 'es' });
  assert.equal(inv.subject, 'Crea tu cuenta para el horario de Rabbits');
  assert.match(inv.text, /Moe te agregó a ShiftBoard/);
  assert.match(inv.text, /sirve por 7 días/);
  const reset = resetEmail({ user, link: 'https://s.co/#/reset?token=y', restaurant: 'Rabbits', hours: 24, lang: 'es' });
  assert.match(reset.text, /Restablece tu contraseña/);
  assert.match(reset.text, /sirve por 24 horas/);
  assert.equal(testEmail({ user, restaurant: 'Rabbits', appUrl: 'https://s.co', lang: 'es' }).subject, 'Correo de prueba de ShiftBoard');
  // English stays exactly as it was.
  const enInv = inviteEmail({ user, link: 'https://s.co/#/reset?token=x', restaurant: 'Rabbits', invitedBy: 'Moe' });
  assert.equal(enInv.subject, 'Set up your Rabbits schedule account');
  assert.match(enInv.text, /^You're on the Rabbits schedule\n\nHi Ana,\n\nMoe added you to ShiftBoard/);
  assert.doesNotMatch(enInv.html, /lang=/);
});

test('tip explanations in Spanish', () => {
  const pool = normalizePool({ id: 'p', name: 'House', jobs: [{ jobCodeId: 'srv', points: 1 }, { jobCodeId: 'bus', points: 0.5 }] });
  const jobName = (id) => ({ srv: 'Server', bus: 'Busser' }[id]);
  const words = describePool(pool, { jobName, lang: 'es' });
  assert.match(words[0], /^Cada día, el fondo es 100% de las propinas con tarjeta y en efectivo\.$/);
  assert.ok(words.some((w) => /quedan fuera/.test(w)));
  const ex = exampleSplit(pool, 50000, { jobName });
  const line = explainShare(pool, ex, ex.people[0], { jobName, you: false, lang: 'es' })[0];
  assert.match(line, / trabajó .+ puntos × un fondo de \$500\.00 = \$/);
  assert.equal(periodLabel('2026-09-28', '2026-10-04'), 'Sep 28 – Oct 4');
  assert.match(periodLabel('2026-09-28', '2026-10-04', 'es'), /^28 sept?\.? – 4 oct\.?$/);
});

// ---------- errors ----------
test('error messages: exact ones and ones with names or numbers, English untouched', () => {
  assert.equal(translateError('Managers only', 'es'), 'Solo para gerentes');
  assert.equal(translateError('Managers only', 'en'), 'Managers only');
  assert.equal(translateError('Swaps need at least 12 hours notice — call your manager', 'es'), 'Los cambios necesitan al menos 12 horas de anticipación. Si falta menos, llama a tu gerente.');
  assert.equal(translateError("Ana isn't trained as Server", 'es'), 'Ana no tiene el puesto de Server');
  assert.equal(translateError('You can’t give someone the Super Admin role', 'es'), 'No puedes darle a nadie el rol de superadministrador');
  assert.equal(translateError('Move or delete its 1 room first', 'es'), 'Primero mueve o borra su salón');
  assert.equal(translateError('Something new nobody listed', 'es'), 'Something new nobody listed');
  for (const [k, v] of Object.entries(ERRORS_ES)) assert.ok(v && v !== k, k);
  // Every fixed message core/ writes with fail(…, '…') has a Spanish version.
  const missing = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'core')).filter((x) => x.endsWith('.js') && x !== 'errors.js')) {
    for (const m of fs.readFileSync(path.join(ROOT, 'core', f), 'utf8').matchAll(/fail\(\d+, '([^']+)'\)/g)) if (translateError(m[1], 'es') === m[1]) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('the API answers errors in the caller’s language', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, headers = {}) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  };
  try {
    // Signed out: the app's language (header), else the browser's.
    assert.equal((await post('/api/auth/login', { email: 'x@y.co', password: 'nope' }, { 'X-ShiftBoard-Language': 'es' })).body.error, 'Correo o contraseña incorrectos');
    assert.equal((await post('/api/auth/login', { email: 'x@y.co', password: 'nope' }, { 'Accept-Language': 'es-MX,es;q=0.9' })).body.error, 'Correo o contraseña incorrectos');
    assert.equal((await post('/api/auth/login', { email: 'x@y.co', password: 'nope' })).body.error, 'Wrong email or password');
    // Signed in: the person's own language.
    const { cookie } = await post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234' });
    const rpc = (m, args, h = {}) => post(`/api/rpc/${m}`, args, { Cookie: cookie, ...h });
    assert.equal((await rpc('shifts.save', {})).body.error, 'Managers only');
    await rpc('account.preferences', { language: 'es' });
    assert.equal((await rpc('shifts.save', {})).body.error, 'Solo para gerentes');
    assert.equal((await rpc('shifts.save', {}, { 'X-ShiftBoard-Language': 'en' })).body.error, 'Solo para gerentes', 'their saved choice wins over the header');
    assert.equal((await rpc('no.such.method', {})).body.error, 'Método desconocido: no.such.method');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
