// Ask ShiftBoard's file imports (server/assistant/imports.js, import-registry.js, import-ai.js), with a fake
// Anthropic client (no network). Every file here is invented and made in the test.
//   - classification of each kind from local signals (XLSX with tabs, a labeled DOCX menu, a BEO PDF and BEO-like
//     text, a roster CSV, a product CSV, a schedule grid, OpenTable and review exports), the AI only when unsure
//   - the manager's pick overrides the guess; the summary card's counts come from the target's own preview
//   - "Import now" is refused while there are possible duplicates or problems; Confirm applies through the
//     target's apply, audited with via: 'assistant'
//   - permissions (staff, a forced target, View as), the AI-unavailable fallback, long documents read in parts,
//     the monthly cap, low-confidence fields, and Spanish
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import bcrypt from 'bcryptjs';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';
import { fakeAnthropic, text } from './helpers/fake-anthropic.js';
import { setAiClientFactory } from '../server/ai/index.js';
import { monthOf, METER } from '../server/ai/usage.js';
import { importTargets, importTarget, registerImportTarget } from '../server/assistant/import-registry.js';
import { extractDocument, readXlsxSheets, chunkText } from '../core/import-detect.js';
import { AI_CHUNK_CHARS } from '../core/smart-import.js';
import { beoItems } from './fixtures/beo-pdf.js';

const KEY = 'sk-ant-test-platform-placeholder-0002'; // not a real key: the fake client never sends it anywhere
const fake = fakeAnthropic();
let A;
const people = {};

before(async () => {
  A = await startApp({ env: { ANTHROPIC_API_KEY: KEY, AI_MESSAGES_PER_MINUTE: '100', AI_CALLS_PER_MINUTE: '500' }, aiClient: fake.factory });
  const pick = (role, n = 0) => A.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[n];
  for (const r of ['admin', 'manager', 'employee']) people[r] = pick(r);
  people.manager2 = pick('manager', 1) || pick('admin', 1);
  people.owner = await A.db.run((s) => s.insert('users', { id: 'usr_import_owner', name: 'Invented Owner', role: 'super_admin', email: 'owner@import.test', active: true,
    jobCodes: [], availability: {}, passwordHash: bcrypt.hashSync('demo1234', 4), createdAt: new Date().toISOString() }), { write: true });
});
after(async () => { setAiClientFactory(null); await A.close(); });

const browsers = new Map();
async function as(who) {
  if (!browsers.has(who)) {
    browsers.set(who, (async () => {
      const c = jsonClient(A.base);
      const r = await signIn(c.post, people[who].email);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const get = async (path) => {
        const res = await fetch(A.base + path, { headers: { Cookie: c.cookie() } });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      /** Attach a file; follows `more` (a long document read in parts) unless once is set. */
      const attach = async (file, extra = {}, { once = false } = {}) => {
        let r = await c.post('/api/assistant/files', { file, ...extra });
        const steps = [r];
        while (!once && r.status === 200 && r.body.result.more) {
          r = await c.post('/api/assistant/files', { file, conversationId: r.body.result.conversationId, ...r.body.result.more });
          steps.push(r);
        }
        return { ...r, steps, card: r.body?.result?.message?.import, result: r.body?.result };
      };
      return { ...c, get, attach };
    })());
  }
  return browsers.get(who);
}

// ---------- invented files ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** An .xlsx with several tabs (inline strings), as base64. */
function xlsx(sheets) {
  const files = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns:r="r"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  sheets.forEach((s, i) => {
    const col = (n) => String.fromCharCode(65 + n);
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  return Buffer.from(zipSync(files)).toString('base64');
}
/** A .docx of paragraphs, as base64. */
function docx(lines) {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  return Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) })).toString('base64');
}
const MENU_SHEET = [['Item', 'Section', 'Description', 'Price', 'Allergens'],
  ['Charred Leek Toast', 'Small Plates', 'Leeks, ricotta, chili oil', '12', 'milk, wheat'],
  ['Saffron Clam Stew', 'Large Plates', 'Clams, fennel, saffron broth', '29', 'shellfish'],
  ['Burnt Honey Tart', 'Desserts', 'Honey custard, sea salt', '10', 'milk, eggs, wheat']];
const LABELED_MENU = ['Small Plates', 'Blistered Shishito Basket', 'Menu Price: $11.00', 'Description:', 'Shishitos with lime salt.', 'Allergens: N/A', 'Friendliness: Vegan, GF',
  'Smoked Carrot Dip', 'Menu Price: $13.00', 'Description: Carrots, tahini, dukkah.', 'Allergens: Sesame, Tree nuts', 'Friendliness: Vegetarian',
  'Large Plates', 'Cider Brined Chop', 'Menu Price: $34.00', 'Description: Pork chop, apples, mustard jus.', 'Allergens: Mustard', 'Friendliness: GF Possible'];
const ROSTER_CSV = 'Name,Email,Phone,Position,Hire Date\nWren Castellano,wren.c@invented.test,(303) 555-0141,Server,2026-03-02\nOrrin Paley,orrin.p@invented.test,(303) 555-0142,Bartender,2026-04-11\n';
const PRODUCT_CSV = 'Product,Category,Unit,Size,Par,Supplier\nInvented Agave Reposado,Spirits,bottle,750 ml,4,Mesa Imports\nInvented Pilsner Keg,Beer,keg,1/2 bbl,2,Front Range Dist\nCocktail Napkins,Paper,case,,1,Paper Co\n';
const AVAIL_ROWS = [['Name', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ['Wren Castellano', 'Any', 'Any', 'After 4p', 'Off', 'Any', 'Any', 'Off'], ['Orrin Paley', 'Off', 'Any', 'Any', 'Any', 'Before 3p', 'Off', 'Any']];
const SCHEDULE_TSV = 'SERVERS\tMONDAY\tTUESDAY\tWEDNESDAY\tTHURSDAY\tFRIDAY\tSATURDAY\tSUNDAY\nWREN C\tOFF\t4PM\t4PM\tOFF\t4:30PM\t3:30PM\tOFF\nORRIN P\t4PM\tOFF\t5PM\t5PM\tOFF\t4PM\t11AM\n';
const BEO_TEXT = `BANQUET EVENT ORDER
Event: Invented Lantern Society Dinner
Event Date: Saturday, October 10, 2026
Guest Count: 40   Guaranteed: 38
Room: Garden Room
Timeline: 6:00 PM arrival, 7:00 PM dinner
Menu: Plated. Beet salad, short rib, tart.
Deposit received: $500.00. Service charge 22%.`;
const file = (name, o) => ({ name, size: (o.text || o.data || '').length, ...o });
const meterReset = () => A.db.run((s) => { for (const d of s.list(METER)) s.remove(METER, d.id); }, { write: true });

// ---------- the registry itself ----------
test('the registry: every target registered once, with detect/parse/preview/permission; a new one plugs in', () => {
  const ids = importTargets().map((t) => t.id);
  for (const id of ['menu', 'employees', 'products', 'availability', 'beo', 'floor', 'schedule', 'opentable', 'reviews']) assert.ok(ids.includes(id), id);
  assert.equal(importTarget('availability').importNow, false, 'its colour-coded workbook is read by its own wizard');
  assert.equal(importTarget('availability').needsFile, true);
  for (const t of importTargets()) for (const k of ['detect', 'parse', 'preview', 'allowed']) assert.equal(typeof t[k], 'function', `${t.id}.${k}`);
  assert.equal(new Set(ids).size, ids.length);
  registerImportTarget({ id: 'zz_test', order: 999, label: { en: 'Test', es: 'Prueba' }, allowed: () => false, detect: () => 0, parse: async () => ({ done: true, payload: {} }), preview: async () => ({ counts: {} }) });
  assert.ok(importTarget('zz_test'));
  assert.throws(() => registerImportTarget({ id: 'bad' }), /needs/);
});

test('reading files: XLSX tabs by name, DOCX text, CSV from bytes (the phone app) or text (the web)', () => {
  const sheets = readXlsxSheets(Buffer.from(xlsx([{ name: 'Notes', rows: [['Updated spring']] }, { name: 'Dinner Menu', rows: MENU_SHEET }]), 'base64'));
  assert.deepEqual(sheets.map((s) => s.name), ['Notes', 'Dinner Menu']);
  assert.equal(sheets[1].rows[1][0], 'Charred Leek Toast');
  const d = extractDocument({ name: 'menu.docx', data: docx(LABELED_MENU) });
  assert.equal(d.kind, 'docx');
  assert.match(d.text, /Menu Price: \$13\.00/);
  const c1 = extractDocument({ name: 'team.csv', data: Buffer.from(ROSTER_CSV).toString('base64') });
  const c2 = extractDocument({ name: 'team.csv', text: ROSTER_CSV });
  assert.deepEqual(c1.sheets, c2.sheets);
  assert.throws(() => extractDocument({ name: 'thing.exe', data: 'AAAA' }), (e) => e.code === 'type');
  assert.throws(() => extractDocument({ name: 'x.csv', text: '' }), (e) => e.code === 'empty');
  assert.deepEqual(chunkText('a\nb', 10), ['a\nb']);
});

// ---------- classification ----------
test('classification from local signals: each kind, no AI call when the signals are sure', async () => {
  fake.clear();
  const mgr = await as('manager');
  const cases = [
    [file('spring.xlsx', { data: xlsx([{ name: 'Notes', rows: [['Updated by the chef']] }, { name: 'Dinner Menu', rows: MENU_SHEET }]) }), 'menu'],
    [file('bar.xlsx', { data: xlsx([{ name: 'Bar inventory', rows: PRODUCT_CSV.trim().split('\n').map((l) => l.split(',')) }]) }), 'products'],
    [file('dishes.docx', { data: docx(LABELED_MENU) }), 'menu'],
    [file('roster.csv', { text: ROSTER_CSV }), 'employees'],
    [file('order-guide.csv', { text: PRODUCT_CSV }), 'products'],
    [file('week.tsv', { text: SCHEDULE_TSV }), 'schedule'],
    [file('avail.xlsx', { data: xlsx([{ name: 'Availability', rows: AVAIL_ROWS }]) }), 'availability'],
    [file('beo.pdf', { items: beoItems() }), 'beo'],
    [file('reservations.csv', { text: await (await import('node:fs/promises')).readFile(new URL('./fixtures/opentable-reservations.csv', import.meta.url), 'utf8') }), 'opentable'],
    [file('google-reviews.csv', { text: await (await import('node:fs/promises')).readFile(new URL('./fixtures/google-reviews.csv', import.meta.url), 'utf8') }), 'reviews'],
  ];
  for (const [f, want] of cases) {
    const r = await mgr.attach(f);
    assert.equal(r.status, 200, `${f.name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.card.target, want, `${f.name} → ${want} (got ${r.card.target}, ${JSON.stringify(r.card)})`);
    assert.equal(fake.calls.length, 0, `${f.name}: no AI call (${JSON.stringify(A.db.store.get('assistantImports', r.card.id)?.scores)})`);
    assert.ok(['high', 'medium'].includes(r.card.confidence), `${f.name}: ${r.card.confidence}`);
    assert.equal(r.card.how, 'local');
    assert.ok(r.card.choices.length > 0 && !r.card.choices.some((c) => c.id === want), 'the other kinds to pick from');
    assert.match(r.result.message.text, /This looks like/);
    assert.equal(r.result.userMessage.file.name, f.name, 'the file is a chip on the person’s message');
  }
  assert.equal(fake.calls.length, 0, 'no AI call: every one was sure from local signals');
});

test('unsure (a picture): a short AI classification call, then the target’s reader (a floor plan)', async () => {
  fake.clear();
  await meterReset();
  const mgr = await as('manager');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fake.reply(text('{"type":"floor","confidence":"high"}'),
    text(JSON.stringify({ room: { x: 0, y: 0, w: 1000, h: 1000 }, items: [{ kind: 'table', shape: 'square', label: '1', seats: 4, x: 100, y: 100, w: 80, h: 80 }, { kind: 'table', shape: 'round', label: '2', seats: 2, x: 300, y: 100, w: 60, h: 60 }], notes: '' })));
  const r = await mgr.attach(file('IMG_0042.png', { data: png, type: 'image/png', mediaType: 'image/png', width: 800, height: 600 }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.card.target, 'floor');
  assert.equal(r.card.how, 'ai');
  assert.equal(r.card.confidence, 'high');
  assert.deepEqual(fake.calls.map((c) => c.params.messages[0].content[0].type), ['image', 'image'], 'the picture goes as an image block');
  const purposes = Object.keys(A.db.store.get(METER, `month:${monthOf(Date.now())}`).purposes);
  assert.ok(purposes.includes('import_classify') && purposes.includes('import_floor'), purposes.join());
  assert.match(r.card.summary.line, /Floor plan: 2 tables, 6 seats/);
});

test('the availability sheet (once it’s a smart-import target): found, previewed, Review & import only', async () => {
  const mgr = await as('manager');
  const r = await mgr.attach(file('avail.xlsx', { data: xlsx([{ name: 'Availability', rows: AVAIL_ROWS }]) }));
  assert.equal(r.card.target, 'availability');
  assert.equal(r.card.wizard, 'smartImport');
  assert.equal(r.card.needsFile, true, 'the wizard reads the file itself (colours, tabs)');
  assert.equal(r.card.canImportNow, false);
  assert.match(r.card.summary.line, /^Availability: 2 people/);
  assert.equal((await mgr.post(`/api/assistant/imports/${r.card.id}/propose`, { conversationId: r.result.conversationId })).status, 409);
});

test('the manager’s pick overrides the guess (the same file read again as another kind)', async () => {
  fake.clear();
  const mgr = await as('manager');
  const f = file('order-guide.csv', { text: PRODUCT_CSV });
  const r = await mgr.attach(f);
  assert.equal(r.card.target, 'products');
  const again = await mgr.attach(f, { importId: r.card.id, target: 'menu', conversationId: r.result.conversationId });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.card.target, 'menu');
  assert.equal(again.card.how, 'picked');
  assert.equal(again.result.message.id, r.result.message.id, 'the same card, updated');
  assert.match(again.result.message.text, /as you picked/);
  assert.equal((await mgr.attach(file('other.csv', { text: ROSTER_CSV }), { importId: r.card.id, target: 'menu' })).status, 409, 'another file is a new message');
});

// ---------- previews, Import now, Confirm ----------
test('routing to the preview: counts from the target’s own preview, possible duplicates need the wizard', async () => {
  fake.clear();
  const mgr = await as('manager');
  await A.db.run((s) => s.insert('menuItems', { id: 'mi_test_dup', name: 'Saffron Clam Stews', category: 'Large Plates', description: '', allergens: [], dietary: [], keyIngredients: [] }), { write: true });
  const r = await mgr.attach(file('spring.xlsx', { data: xlsx([{ name: 'Menu', rows: MENU_SHEET }]) }));
  assert.equal(r.card.status, 'ready');
  assert.equal(r.card.wizard, 'smartImport');
  assert.match(r.card.summary.line, /^Menu: 3 dishes in 3 sections; .*2 new.*1 possible duplicate to check/);
  assert.equal(r.card.summary.counts.check, 1);
  assert.equal(r.card.canImportNow, false, 'a possible duplicate: no Import now');
  assert.equal(r.card.needsReview, true);
  const p = await mgr.post(`/api/assistant/imports/${r.card.id}/propose`, { conversationId: r.result.conversationId });
  assert.equal(p.status, 409);
  assert.match(p.body.error, /possible duplicates/);
  // Review & import: the wizard pre-loads the records.
  const w = await mgr.get(`/api/assistant/imports/${r.card.id}`);
  assert.equal(w.status, 200);
  assert.equal(w.body.result.wizard, 'smartImport');
  assert.equal(w.body.result.payload.records.length, 3);
  assert.equal(w.body.result.payload.records[1].values.name, 'Saffron Clam Stew');
  await A.db.run((s) => s.remove('menuItems', 'mi_test_dup'), { write: true });
});

test('problems also stop Import now (a position ShiftBoard doesn’t have)', async () => {
  const mgr = await as('manager');
  const r = await mgr.attach(file('crew.csv', { text: 'Name,Email,Position\nTamsin Vale,tamsin.v@invented.test,Invented Juggler\n' }));
  assert.equal(r.card.target, 'employees');
  assert.equal(r.card.summary.counts.problem, 1, JSON.stringify(r.card.summary));
  assert.equal(r.card.canImportNow, false);
  assert.equal((await mgr.post(`/api/assistant/imports/${r.card.id}/propose`, { conversationId: r.result.conversationId })).status, 409);
});

test('Import now → a confirm card; Confirm applies through the target’s apply, audited via the assistant', async () => {
  const mgr = await as('manager');
  const r = await mgr.attach(file('dishes.docx', { data: docx(LABELED_MENU) }));
  assert.equal(r.card.target, 'menu');
  assert.match(r.card.summary.line, /Menu: 3 dishes in 2 sections; 3 new/);
  assert.equal(r.card.canImportNow, true);
  assert.equal(A.db.store.list('menuItems', (m) => m.name === 'Smoked Carrot Dip').length, 0, 'nothing saved by the preview');
  const p = await mgr.post(`/api/assistant/imports/${r.card.id}/propose`, { conversationId: r.result.conversationId });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const action = p.body.result.message.actions.at(-1);
  assert.equal(action.status, 'proposed');
  assert.match(action.title, /Import menu/);
  assert.equal(A.db.store.list('menuItems', (m) => m.name === 'Smoked Carrot Dip').length, 0, 'still nothing saved');
  const c = await mgr.post(`/api/assistant/actions/${action.id}`, { conversationId: r.result.conversationId, decision: 'confirm' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.result.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.result.action.status, 'done');
  await A.db.sync();
  const dip = A.db.store.list('menuItems', (m) => m.name === 'Smoked Carrot Dip')[0];
  assert.ok(dip);
  assert.equal(dip.price, 13);
  const audit = A.db.store.list('auditLog', (a) => a.action === 'import.menu').sort((a, b) => b.at.localeCompare(a.at))[0];
  assert.equal(audit.via, 'assistant');
  assert.equal(audit.details.created, 3);
  assert.ok(A.db.store.list('auditLog', (a) => a.action === 'assistant.import_file' && a.via === 'assistant').length, 'the assistant’s own entry');
  // Twice: the card says done, and a second confirm does nothing.
  const again = await mgr.post(`/api/assistant/actions/${action.id}`, { conversationId: r.result.conversationId, decision: 'confirm' });
  assert.equal(again.status, 409);
  const chat = (await mgr.get(`/api/assistant/conversations/${r.result.conversationId}`)).body.result;
  assert.equal(chat.messages.find((m) => m.id === r.result.message.id).import.status, 'done');
});

test('a BEO PDF: events from the Tripleseat layout, previewed with events.importBeos dryRun', async () => {
  const mgr = await as('manager');
  const r = await mgr.attach(file('beos.pdf', { items: beoItems() }));
  assert.equal(r.card.target, 'beo');
  assert.equal(r.card.wizard, 'beo');
  assert.match(r.card.summary.line, /^BEO: 3 events; 3 new/);
  const w = await mgr.get(`/api/assistant/imports/${r.card.id}`);
  assert.equal(w.body.result.payload.events.length, 3);
  assert.ok(!JSON.stringify(w.body.result.payload).includes('$'), 'no money');
});

test('BEO-like text read by AI: the BEO section model, money stripped, low-confidence fields, purpose import_beo', async () => {
  fake.clear();
  const mgr = await as('manager');
  fake.reply(text(JSON.stringify({ events: [{ name: 'Invented Lantern Society Dinner', date: '2026-10-10', start: '18:00', guestCount: 40, guaranteed: 38, areas: 'Garden Room',
    specialInstructions: 'Deposit received: $500.00', menu: [{ course: 'Plated', item: 'Beet salad' }], ssn: '123-45-6789', _unsure: ['guaranteed'] }] })));
  const r = await mgr.attach(file('lantern-beo.txt', { text: BEO_TEXT }));
  assert.equal(r.card.target, 'beo', JSON.stringify(r.card));
  assert.equal(r.card.source, 'ai');
  assert.equal(r.card.lowConfidence, 1);
  assert.match(r.card.summary.line, /Invented Lantern Society Dinner, 2026-10-10, 40 guests; 1 new/);
  assert.equal(fake.calls.length, 1, 'sure it’s a BEO locally: only the reading call');
  assert.match(fake.calls[0].params.system[0].text, /NO MONEY/);
  const w = (await mgr.get(`/api/assistant/imports/${r.card.id}`)).body.result.payload;
  assert.ok(!JSON.stringify(w.events).includes('$500'), 'money stripped again server-side');
  assert.ok(!JSON.stringify(w.events).includes('123-45'), 'unknown fields dropped');
  assert.deepEqual(w.lowConfidence, [['guaranteed']]);
});

test('AI field mapping for a menu that isn’t a table: strict rows, the normalisers, unsure fields highlighted', async () => {
  fake.clear();
  const mgr = await as('manager');
  fake.reply(text('{"type":"menu","confidence":"medium"}'), text(JSON.stringify({ rows: [
    { name: 'Invented Ember Wings', category: 'Snacks', price: '15', allergens: 'milk', _unsure: ['price'] },
    { name: 'Invented Juniper Fizz', category: 'Cocktails', price: '14', ssn: '000-00-0000' },
    { description: 'no name: dropped' },
  ] })));
  const menu = 'SNACKS\nInvented Ember Wings — buttermilk, hot honey ... 15\nCOCKTAILS\nInvented Juniper Fizz — gin, juniper, soda ... 14\nAsk about our specials tonight';
  const r = await mgr.attach(file('menu.txt', { text: menu }), { message: 'import this menu' });
  assert.equal(r.card.target, 'menu', JSON.stringify(r.card));
  assert.equal(r.card.how, 'ai', 'unsure locally: the short classification call first');
  assert.equal(fake.calls[0].params.max_tokens, 400);
  assert.equal(r.card.source, 'ai');
  assert.equal(r.card.lowConfidence, 1);
  assert.equal(r.card.summary.counts.total, 2);
  assert.equal(fake.calls.at(-1).params.messages[0].content.includes('<document>'), true);
  const payload = (await mgr.get(`/api/assistant/imports/${r.card.id}`)).body.result.payload;
  assert.deepEqual(payload.lowConfidence, [['price'], []]);
  assert.ok(!JSON.stringify(payload).includes('000-00'), 'only the target’s fields');
});

test('long documents are read in parts (each inside the 30 s limit), rows numbered across parts', async () => {
  fake.clear();
  const mgr = await as('manager');
  const lines = [];
  for (let i = 0; i < 160; i++) lines.push(`Invented Dish Number ${i} — a long description of the plate with seasonal vegetables ... ${10 + (i % 20)}`);
  const doc = lines.join('\n');
  const parts = chunkText(doc).length;
  assert.ok(doc.length > AI_CHUNK_CHARS * 2 && parts >= 3, `${parts} parts`);
  for (let p = 0; p < parts; p++) fake.reply(text(JSON.stringify({ rows: [{ name: `Invented Part Dish ${p}a`, category: 'Mains' }, { name: `Invented Part Dish ${p}b`, category: 'Mains' }] })));
  const r = await mgr.attach(file('long-menu.txt', { text: doc }), { message: 'our menu' });
  assert.equal(r.steps.length, parts, 'one request per part');
  assert.ok(r.steps.slice(0, -1).every((s) => s.body.result.message.import.status === 'reading' && s.body.result.more), 'reading… with the next part');
  assert.equal(r.card.status, 'ready');
  assert.equal(r.card.summary.counts.total, parts * 2);
  assert.equal(fake.calls.filter((c) => /<document>/.test(JSON.stringify(c.params.messages))).length, parts);
  const recs = (await mgr.get(`/api/assistant/imports/${r.card.id}`)).body.result.payload.records;
  assert.deepEqual(recs.map((x) => x.row), recs.map((_, i) => i + 1), 'rows numbered across the parts');
});

test('AI unavailable (the API fails): the structured readers instead, and the card says AI reading isn’t set up', async () => {
  fake.clear();
  const mgr = await as('manager');
  fake.reply(Object.assign(new Error('boom'), { status: 500 }));
  const menu = 'STARTERS\nInvented Radish Plate ..... 9\nInvented Nettle Soup ..... 11\nMAINS\nInvented Mushroom Pie ..... 24';
  const r = await mgr.attach(file('menu-plain.txt', { text: menu }), { message: 'menu' });
  assert.equal(r.card.target, 'menu');
  assert.equal(r.card.source, 'simple');
  assert.equal(r.card.summary.counts.total, 3);
  assert.ok(r.card.notes.some((n) => /AI reading isn’t set up/.test(n)), JSON.stringify(r.card.notes));
});

test('the monthly cap is respected: no AI call at all, local readers, the cap note', async () => {
  fake.clear();
  await A.db.run((s) => {
    const id = `month:${monthOf(Date.now())}`;
    const doc = { id, month: monthOf(Date.now()), platformUsd: 9999, ownUsd: 0, calls: 1, errors: 0, users: {}, purposes: {} };
    if (s.get(METER, id)) s.update(METER, id, doc); else s.insert(METER, doc);
  }, { write: true });
  const mgr = await as('manager');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pic = await mgr.attach(file('photo.png', { data: png, type: 'image/png' }));
  assert.equal(pic.status, 200);
  assert.equal(pic.card.target, null, 'not sure, and no AI to ask');
  assert.match(pic.result.message.text, /not sure/);
  const r = await mgr.attach(file('menu-plain.txt', { text: 'STARTERS\nInvented Kale Chips ..... 7\nInvented Pea Toast ..... 9\nInvented Fig Salad ..... 12' }), { message: 'menu' });
  assert.equal(r.card.source, 'simple');
  assert.ok(r.card.notes.some((n) => /allowance is used up/.test(n)), JSON.stringify(r.card.notes));
  assert.equal(fake.calls.length, 0, 'nothing sent to the AI over the cap');
  await meterReset();
});

// ---------- permissions ----------
test('permissions: staff see what it is but “Only managers can import this”; no AI spent; no forced target', async () => {
  fake.clear();
  const emp = await as('employee');
  const r = await emp.attach(file('dishes.docx', { data: docx(LABELED_MENU) }));
  assert.equal(r.status, 200);
  assert.equal(r.card.target, 'menu');
  assert.equal(r.card.status, 'refused');
  assert.equal(r.card.refused, 'Only managers can import this.');
  assert.equal(r.card.canImportNow, false);
  assert.equal(r.card.wizard, null);
  assert.deepEqual(r.card.choices, [], 'nothing to pick from');
  assert.match(r.result.message.text, /Only managers can import this/);
  assert.equal((await emp.attach(file('dishes.docx', { data: docx(LABELED_MENU) }), { target: 'menu' })).status, 403);
  assert.equal((await emp.get(`/api/assistant/imports/${r.card.id}`)).status, 403);
  assert.equal((await emp.post(`/api/assistant/imports/${r.card.id}/propose`, {})).status, 403);
  // Someone else's import is not found.
  const mgr = await as('manager');
  assert.equal((await mgr.get(`/api/assistant/imports/${r.card.id}`)).status, 404);
  assert.equal(fake.calls.length, 0);
});

test('permissions: Roles & features turn an import off for a role (managers without Training: no menu import)', async () => {
  const admin = await as('admin');
  const save = await admin.post('/api/rpc/roleFeatures.save', { roleFeatures: { manager: { training: false } } });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const mgr = await as('manager');
  const r = await mgr.attach(file('dishes.docx', { data: docx(LABELED_MENU) }));
  assert.equal(r.card.target, 'menu');
  assert.equal(r.card.status, 'refused');
  assert.match(r.card.refused, /role or your restaurant’s plan/);
  assert.ok(!r.card.choices.some((c) => c.id === 'menu'));
  assert.ok(r.card.choices.some((c) => c.id === 'employees'), 'the rest of a manager’s imports are still offered');
  assert.equal((await admin.post('/api/rpc/roleFeatures.save', { roleFeatures: { manager: { training: true } } })).status, 200);
});

test('View as is read-only: no file imports while viewing someone', async () => {
  const boss = await as('owner');
  assert.equal((await boss.post('/api/view-as/start', { userId: people.employee.id })).status, 200);
  const r = await boss.post('/api/assistant/files', { file: file('roster.csv', { text: ROSTER_CSV }) });
  assert.equal(r.status, 403);
  await boss.post('/api/view-as/stop', {});
});

test('files that can’t be read get a friendly answer', async () => {
  const mgr = await as('manager');
  const r = await mgr.post('/api/assistant/files', { file: { name: 'virus.exe', data: 'AAAA' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /PDF, Word/);
});

// ---------- Spanish ----------
test('Spanish: the reply, the summary card and the refusals', async () => {
  const mgr = await as('manager2');
  await mgr.post('/api/rpc/account.preferences', { language: 'es' });
  const r = await mgr.attach(file('equipo.csv', { text: 'Nombre,Correo,Teléfono,Puesto\nIvette Soler,ivette.s@invented.test,(303) 555-0161,Server\n' }));
  assert.equal(r.card.target, 'employees');
  assert.equal(r.card.label, 'Lista del equipo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.result.message.text, /^Esto parece \*\*una lista del equipo\*\* \(confianza (alta|media)\)\. ¿No es eso\?/);
  assert.match(r.card.summary.line, /^Lista del equipo: 1 persona; 1 nuevo/, r.card.summary.line);
  assert.ok(r.card.choices.some((c) => c.label === 'Menú'), JSON.stringify(r.card.choices));
  const bad = await mgr.post('/api/assistant/files', { file: { name: 'x.exe', data: 'AAAA' } });
  assert.match(bad.body.error, /Puedo leer PDF/);
  await mgr.post('/api/rpc/account.preferences', { language: 'en' });
});
