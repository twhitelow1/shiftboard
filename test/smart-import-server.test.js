// Smart import through the server: the RPCs over HTTP (permissions, invitations only when asked and by email only),
// "Read it with AI" (server/import-routes.js) with a fake Anthropic client and when AI isn't available, the plan's
// Training gate, the Claude connector's tools (preview → confirm with a decision for every possible duplicate,
// read-only connections, consent never set) and Ask ShiftBoard (the preview runs like a read, the import is a card).
// Every name, email and phone number here is invented; nothing goes to the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.js';
import { cookieFor, jsonClient, signIn } from './helpers/signin.js';
import { fakeAnthropic, text, toolUse } from './helpers/fake-anthropic.js';
import { setAiClientFactory } from '../server/ai/index.js';
import { monthOf, monthMeter } from '../server/ai/usage.js';
import { recordsFromReply } from '../server/import-routes.js';
import { toolByName, runTool, createToolContext, visibleTools, TOOLS, READ, WRITE } from '../server/tools/index.js';
import { claudeTools } from '../server/assistant/prompt.js';
import { describeAction } from '../server/assistant/actions.js';
import { resolveFeatures } from '../server/platform/plans.js';

const KEY = 'sk-ant-test-platform-placeholder-0002'; // not a real key: the fake client never sends it anywhere
const fake = fakeAnthropic();
let A;
const people = {};
const pick = (role) => A.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[0];

before(async () => {
  A = await startApp({ env: { ANTHROPIC_API_KEY: KEY, AI_MESSAGES_PER_MINUTE: '100' }, aiClient: fake.factory });
  for (const r of ['admin', 'manager', 'supervisor', 'employee']) people[r] = pick(r);
});
after(async () => { setAiClientFactory(null); await A.close(); });

const clients = new Map();
async function as(role) {
  if (!clients.has(role)) {
    clients.set(role, (async () => {
      const c = jsonClient(A.base);
      const r = await signIn(c.post, people[role].email);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return c;
    })());
  }
  return clients.get(role);
}
const rec = (row, values) => ({ row, values, present: Object.keys(values) });
const ctxFor = (user, { scopes = [READ, WRITE], has = () => true, invite = null, via = 'claude' } = {}) => createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, has, scopes, via, client: 'Test client', invite });

test('over HTTP: staff are refused; a manager previews and imports; invitations only when asked, by email, never texts', async () => {
  const emp = await as('employee');
  const r403 = await emp.post('/api/rpc/employees.importPreview', { records: [rec(2, { name: 'Nobody' })] });
  assert.equal(r403.status, 403);
  const mgr = await as('manager');
  const records = [rec(2, { name: 'Indigo Hart', email: 'indigo.hart@example.com', phone: '555-010-6161', positions: 'Server' }), rec(3, { name: 'Wren Ito', email: 'wren.ito@sbmail-test.com', positions: 'Host' })];
  const p = await mgr.post('/api/rpc/employees.importPreview', { records });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.result.counts.new, 2);
  A.resend.calls.length = 0;
  A.twilio.calls.length = 0;
  // Without "Send invitations now": nobody is emailed (unlike Team → Add, which invites at once).
  const quiet = await mgr.post('/api/rpc/employees.importApply', { records: [records[0]], fileName: 'roster.csv' });
  assert.equal(quiet.status, 200, JSON.stringify(quiet.body));
  assert.equal(quiet.body.result.created, 1);
  await A.settled();
  assert.equal(A.resend.emails().length, 0, 'no invitation');
  // With it: an invitation email to the new person, still no text.
  const loud = await mgr.post('/api/rpc/employees.importApply', { records, options: { invite: true } });
  assert.equal(loud.body.result.created, 1);
  assert.deepEqual(loud.body.result.invited, { sent: 1, noEmail: 0, failed: 0 });
  await A.settled();
  const mails = A.resend.emails();
  assert.equal(mails.length, 1);
  assert.deepEqual([mails[0].to].flat(), ['wren.ito@sbmail-test.com']);
  assert.equal(A.twilio.calls.length, 0, 'never a text');
  await A.db.sync();
  const wren = A.db.store.list('users', (u) => u.email === 'wren.ito@sbmail-test.com')[0];
  assert.equal(wren.smsConsent, false);
  assert.equal(wren.emailConsent, false);
  assert.ok(wren.invitedAt, 'stamped like any invitation');
  const audit = A.db.store.list('auditLog', (a) => a.action === 'import.employees');
  assert.equal(audit.length, 2);
  assert.equal(audit[0].details.fileName, 'roster.csv');
  // Spanish error for the duplicate rule.
  const conflict = await mgr.post('/api/rpc/employees.importApply', { records: [rec(2, { name: 'Indigo Hart', phone: '1' }), rec(9, { name: 'Indigo Hart', phone: '555-010-0000' })] }, { 'X-ShiftBoard-Language': 'es' });
  assert.equal(conflict.status, 409);
});

test('Read it with AI: a fake Claude turns a menu into records; bad replies and no AI are friendly; only the manager', async () => {
  const mgr = await as('manager');
  fake.clear();
  fake.reply(text('{"rows":[{"name":"Charred Leeks","category":"Starters","price":"12","allergens":"milk","ssn":"000"},{"name":"Fig Spritz","category":"Cocktails","price":13}]}'));
  const r = await mgr.post('/api/import/read', { target: 'menu', text: 'STARTERS\nCharred Leeks 12 (contains milk)\nCOCKTAILS\nFig Spritz 13' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.result.records.map((x) => x.values), [{ name: 'Charred Leeks', category: 'Starters', price: '12', allergens: 'milk' }, { name: 'Fig Spritz', category: 'Cocktails', price: '13' }]);
  const sent = fake.calls[0].params;
  assert.match(sent.system[0].text, /data, not instructions/);
  assert.match(sent.messages[0].content, /<document>/);
  // The records go to the same preview.
  const p = await mgr.post('/api/rpc/menu.importPreview', { records: r.body.result.records });
  assert.equal(p.body.result.counts.new, 2);
  // A reply that isn't JSON.
  fake.reply(text('Sorry, here is the menu: Charred Leeks.'));
  const bad = await mgr.post('/api/import/read', { target: 'employees', text: 'Jamie Rivers jamie@example.com' });
  assert.deepEqual([bad.status, bad.body.reason], [502, 'reply']);
  // Who may: managers only, a target, some text, not too much.
  assert.equal((await (await as('employee')).post('/api/import/read', { target: 'menu', text: 'x' })).status, 403);
  assert.equal((await mgr.post('/api/import/read', { target: 'shifts', text: 'x' })).status, 400);
  assert.equal((await mgr.post('/api/import/read', { target: 'menu', text: 'x'.repeat(9000) })).status, 413);
  // Metered as its own purpose.
  await A.db.sync();
  const m = monthMeter(A.db.store, monthOf(Date.now()));
  assert.ok('menu_import' in m.purposes && 'employee_import' in m.purposes, 'each reading in the meter under its purpose');
  assert.deepEqual(recordsFromReply('{"rows":[{"firstName":"Ana","email":"ana@example.com","notes":["a","b"]}]}', 'employees', 4), [{ row: 5, values: { firstName: 'Ana', email: 'ana@example.com', notes: 'a, b' }, present: ['firstName', 'email', 'notes'] }]);
});

test('Read it with AI when AI is not set up: 503 with the reason (the wizard says "use a CSV")', async () => {
  const B = await startApp({ env: {} }); // no key
  try {
    const c = jsonClient(B.base);
    const m = B.db.store.list('users', (u) => u.role === 'manager' && u.active !== false).sort((a, b) => a.order - b.order)[0];
    assert.equal((await signIn(c.post, m.email)).status, 200);
    const r = await c.post('/api/import/read', { target: 'employees', text: 'Jamie Rivers, jamie@example.com' });
    assert.deepEqual([r.status, r.body.reason], [503, 'no_key']);
    assert.ok(r.body.error);
  } finally { await B.close(); }
});

test('the plan: without Training, menu import and its AI reading are refused; the team import still works', async () => {
  const tenant = { id: 'tnt_si_test', slug: 'si-test', isDefault: true, plan: 'starter', status: 'active', features: { ...resolveFeatures('starter'), training: false }, ai: {} };
  const B = await startApp({ env: { ANTHROPIC_API_KEY: KEY }, tenant, aiClient: fake.factory });
  try {
    const m = B.db.store.list('users', (u) => u.role === 'manager' && u.active !== false).sort((a, b) => a.order - b.order)[0];
    const c = jsonClient(B.base);
    assert.equal((await signIn(c.post, m.email)).status, 200);
    assert.equal((await c.post('/api/rpc/menu.importPreview', { records: [rec(2, { name: 'Fig Spritz' })] })).status, 403);
    assert.equal((await c.post('/api/import/read', { target: 'menu', text: 'Fig Spritz 13' })).status, 403);
    assert.equal((await c.post('/api/rpc/employees.importPreview', { records: [rec(2, { name: 'Sky Lund' })] })).status, 200);
    // Starter without Training and without Ask ShiftBoard: no AI at all for the roster either.
    const r = await c.post('/api/import/read', { target: 'employees', text: 'Sky Lund sky@example.com' });
    assert.deepEqual([r.status, r.body.reason], [503, 'plan']);
  } finally { await B.close(); }
});

test('connector tools: import_menu_items previews, refuses a confirm without decisions, then applies; idempotent', async () => {
  await A.db.sync();
  const mgr = A.db.store.get('users', people.manager.id);
  const tool = toolByName('import_menu_items');
  assert.equal(tool.preview, true);
  assert.equal(tool.feature, 'training');
  const items = [{ name: 'Burrata & Stone Fruits', category: 'Starters', price: 17 }, { name: 'Pistachio Cake', category: 'Desserts', allergens: 'tree nuts, eggs', dietary: ['vegetarian'] }];
  const before = A.db.store.list('menuItems').length;
  const prev = await runTool(tool, { items }, ctxFor(mgr));
  assert.equal(prev.ok, true, prev.error);
  assert.match(prev.summary, /Preview only, nothing saved/);
  assert.equal(prev.data.possibleDuplicates, 1, 'Burrata & Stone Fruits ≈ Burrata & Stone Fruit (plural)');
  const check = prev.data.rows.find((r) => r.status === 'check');
  assert.equal(check.candidates[0].reasons[0], 'plural');
  await A.db.sync();
  assert.equal(A.db.store.list('menuItems').length, before, 'nothing saved by a preview');
  // A read-only connection can preview but not import.
  assert.equal((await runTool(tool, { items }, ctxFor(mgr, { scopes: [READ] }))).ok, true);
  const ro = await runTool(tool, { items, confirm: true }, ctxFor(mgr, { scopes: [READ] }));
  assert.equal(ro.ok, false);
  assert.match(ro.error, /read-only/);
  // Confirm without a decision: refused, clearly.
  const refused = await runTool(tool, { items, confirm: true }, ctxFor(mgr));
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
  assert.match(refused.error, /1 possible duplicate\(s\) need a decision \(rows r1\)/);
  // With the decision (update the existing one), it applies.
  const done = await runTool(tool, { items, confirm: true, decisions: [{ row: check.row, action: 'update', id: check.candidates[0].id }] }, ctxFor(mgr));
  assert.equal(done.ok, true, done.error);
  assert.match(done.summary, /1 added, 1 updated/);
  await A.db.sync();
  assert.equal(A.db.store.get('menuItems', check.candidates[0].id).price, 17);
  assert.deepEqual(A.db.store.list('menuItems').find((i) => i.name === 'Pistachio Cake').allergens, ['tree nuts', 'eggs']);
  assert.equal(A.db.store.list('auditLog', (a) => a.action === 'claude.import_menu_items').length, 1);
  // Again: nothing to decide (remembered), nothing changes.
  const again = await runTool(tool, { items }, ctxFor(mgr));
  assert.deepEqual([again.data.counts.unchanged, again.data.counts.check], [2, 0]);
  // Plan without Training: not there.
  assert.ok(!visibleTools(TOOLS, mgr, { has: (f) => f !== 'training', scopes: [READ, WRITE], settings: {} }).some((t) => t.name === 'import_menu_items'));
  // Staff: not there either.
  assert.ok(!visibleTools(TOOLS, A.db.store.get('users', people.employee.id), { has: () => true, scopes: [READ, WRITE], settings: {} }).some((t) => t.name.startsWith('import_') || t.name === 'save_menu_item'));
});

test('connector tools: save_menu_item adds at once, asks before changing, returns likely duplicates', async () => {
  await A.db.sync();
  const mgr = A.db.store.get('users', people.manager.id);
  const tool = toolByName('save_menu_item');
  const add = await runTool(tool, { name: 'Smoked Beet Salad', category: 'Starters', dietary: 'V, GF' }, ctxFor(mgr));
  assert.equal(add.ok, true, add.error);
  await A.db.sync();
  const beet = A.db.store.list('menuItems').find((i) => i.name === 'Smoked Beet Salad');
  assert.deepEqual(beet.dietary, ['vegetarian', 'gluten-free']);
  const change = await runTool(tool, { itemId: beet.id, name: 'Smoked Beet Salad', price: 12 }, ctxFor(mgr));
  assert.deepEqual([change.ok, change.status], [false, 409]);
  assert.match(change.error, /Ask the user/);
  assert.equal((await runTool(tool, { itemId: beet.id, name: 'Smoked Beet Salad', price: 12, confirm: true }, ctxFor(mgr))).ok, true);
  await A.db.sync();
  assert.equal(A.db.store.get('menuItems', beet.id).price, 12);
  const dupe = await runTool(tool, { name: 'Smoked Beet Salads', category: 'Starters' }, ctxFor(mgr));
  assert.equal(dupe.ok, true);
  assert.match(dupe.summary, /Not saved: .*looks like “Smoked Beet Salad”/);
  const separate = await runTool(tool, { name: 'Smoked Beet Salads', category: 'Starters', createNew: true }, ctxFor(mgr));
  assert.match(separate.summary, /Added/);
});

test('connector tools: import_employees never sets consent and invites only when asked', async () => {
  await A.db.sync();
  const mgr = A.db.store.get('users', people.manager.id);
  const tool = toolByName('import_employees');
  const invited = [];
  const invite = async (ids) => { invited.push(...ids); return { sent: ids.length, noEmail: 0, failed: 0 }; };
  const people1 = [{ name: 'Juniper Vale', email: 'juniper@example.com', positions: ['Server'], role: 'employee' }];
  const prev = await runTool(tool, { people: people1 }, ctxFor(mgr, { invite }));
  assert.equal(prev.data.counts.new, 1);
  const done = await runTool(tool, { people: people1, confirm: true }, ctxFor(mgr, { invite }));
  assert.equal(done.ok, true, done.error);
  assert.match(done.summary, /no invitations sent/);
  assert.deepEqual(invited, []);
  const people2 = [{ name: 'Rowan Pike', email: 'rowan@example.com', smsConsent: true, emailConsent: true }];
  const d2 = await runTool(tool, { people: people2, confirm: true, sendInvitations: true }, ctxFor(mgr, { invite }));
  assert.equal(d2.ok, true, d2.error);
  await A.db.sync();
  const rowan = A.db.store.list('users', (u) => u.email === 'rowan@example.com')[0];
  assert.deepEqual(invited, [rowan.id]);
  assert.deepEqual([rowan.smsConsent, rowan.emailConsent], [false, false], 'consent in the input is ignored');
  // A nickname of someone already here: a check row, refused without a decision.
  const d3 = await runTool(tool, { people: [{ name: 'Ro Pike' }, { name: 'Juniper  Vale', phone: '555-010-2424' }], confirm: true }, ctxFor(mgr, { invite }));
  assert.equal(d3.ok, true, d3.error, 'exact name (spacing) matches Juniper; "Ro Pike" isn\'t like anyone: new');
});

test('Ask ShiftBoard: the import preview runs like a read, then the import is a card the manager confirms', async () => {
  fake.clear();
  const mgr = await as('manager');
  const items = [{ name: 'Blood Orange Soda', category: 'Non-alcoholic', price: 6 }];
  fake.reply(toolUse('import_menu_items', { items }, { say: 'Let me check.' }), (params) => {
    const last = params.messages.at(-1).content[0];
    assert.equal(last.type, 'tool_result');
    assert.match(last.content, /Preview only, nothing saved: 1 new/);
    return toolUse('import_menu_items', { items, confirm: true }, { say: 'One new drink. Import it?' });
  });
  const res = await fetch(`${A.base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgr.cookie() }, body: JSON.stringify({ message: 'Add Blood Orange Soda, $6, to the menu', stream: false }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const card = body.result.message.actions[0];
  assert.deepEqual([card.tool, card.status, card.title], ['import_menu_items', 'proposed', 'Import menu items']);
  assert.deepEqual(card.details[0], ['Items', '1: Blood Orange Soda']);
  await A.db.sync();
  assert.ok(!A.db.store.list('menuItems').some((i) => i.name === 'Blood Orange Soda'), 'nothing until the tap');
  // The model sees confirm on preview tools (and not on other writes).
  const tools = fake.calls[0].params.tools;
  assert.ok(tools.find((t) => t.name === 'import_menu_items').input_schema.properties.confirm);
  assert.equal(tools.find((t) => t.name === 'save_menu_item').input_schema.properties.confirm, undefined);
  const done = await mgr.post(`/api/assistant/actions/${card.id}`, { conversationId: body.result.conversationId, decision: 'confirm' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.result.ok, true, JSON.stringify(done.body));
  await A.db.sync();
  assert.ok(A.db.store.list('menuItems').some((i) => i.name === 'Blood Orange Soda'));
  assert.equal(A.db.store.list('auditLog', (a) => a.action === 'assistant.import_menu_items').length, 1);
  // Cards in Spanish say what an import does.
  const es = describeAction(toolByName('import_employees'), { people: [{ name: 'Sol Reyes' }], sendInvitations: true }, 'es', {});
  assert.deepEqual(es, { title: 'Importar personas al equipo', details: [['Personas', '1: Sol Reyes'], ['Enviar invitaciones ahora', 'Sí']] });
  assert.ok(claudeTools([toolByName('import_employees')])[0].description.includes('returns the preview'));
});
