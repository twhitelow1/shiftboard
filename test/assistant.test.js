// Ask ShiftBoard (server/assistant/) and ShiftBoard's AI (server/ai/), with a fake Anthropic client (no network):
//   - cost math and metering: every call in the ledger and the meter, no prompts or replies kept there
//   - complete() for other features (purpose 'review_reply'): no tools, metered, the same caps
//   - the monthly cap (friendly message, EN/ES, the 80% warning once), the daily message limit, a restaurant's own key
//   - the tool loop: reads run as the person, a change stops the loop and comes back as a card; Confirm runs it once,
//     audited; Cancel doesn't
//   - permissions: an employee's tools are an employee's; Roles & features and the restaurant's switches apply
//   - View as: no assistant, nothing spent; conversations are the person's own; Spanish all the way
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';
import { fakeAnthropic, text, toolUse, refusal } from './helpers/fake-anthropic.js';
import { aiFor, AiUnavailable, costUsd, MODEL, PRICES, capFor, setAiClientFactory } from '../server/ai/index.js';
import { monthOf, dayOf, monthMeter, METER, localUsageLog } from '../server/ai/usage.js';
import { aiMessage } from '../server/ai/messages.js';
import { tenantEnv } from '../server/platform/tenant-env.js';
import { restaurantView } from '../server/platform/integrations.js';
import { claudeTools } from '../server/assistant/prompt.js';
import { describeAction } from '../server/assistant/actions.js';
import { TOOLS, toolByName } from '../server/tools/index.js';
import { addDays, weekStart } from '../core/time.js';
import { todayOf } from '../server/tools/dates.js';
import { resolveFeatures } from '../server/platform/plans.js';

const KEY = 'sk-ant-test-platform-placeholder-0001'; // not a real key: the fake client never sends it anywhere
const fake = fakeAnthropic();
let A;
const people = {};

before(async () => {
  A = await startApp({ env: { ANTHROPIC_API_KEY: KEY, AI_MESSAGES_PER_MINUTE: '100' }, aiClient: fake.factory });
  const pick = (role, n = 0) => A.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[n];
  for (const r of ['admin', 'manager', 'supervisor', 'employee']) people[r] = pick(r);
  people.employee2 = pick('employee', 3);
  people.owner = await A.db.run((s) => s.insert('users', { id: 'usr_test_owner', name: 'Pat Owner', role: 'super_admin', email: 'owner@assistant.test', active: true,
    jobCodes: [], availability: {}, passwordHash: bcrypt.hashSync('demo1234', 4), createdAt: new Date().toISOString() }), { write: true });
});
after(async () => { setAiClientFactory(null); await A.close(); });

/** A signed-in browser for one person (one sign-in each: authenticator codes work once). */
const browsers = new Map();
async function as(who) {
  if (!browsers.has(who)) browsers.set(who, browserFor(who));
  return browsers.get(who);
}
async function browserFor(who) {
  const c = jsonClient(A.base);
  const r = await signIn(c.post, people[who].email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const get = async (path) => {
    const res = await fetch(A.base + path, { headers: { Cookie: c.cookie() } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  /** Ask (streamed): the NDJSON lines, and the final message. */
  const ask = async (message, extra = {}) => {
    const res = await fetch(`${A.base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.cookie() }, body: JSON.stringify({ message, ...extra }) });
    const raw = await res.text();
    if (!/ndjson/.test(res.headers.get('content-type') || '')) return { status: res.status, body: JSON.parse(raw) };
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    const done = lines.find((l) => l.type === 'done');
    return { status: res.status, lines, done, text: lines.filter((l) => l.type === 'text').map((l) => l.text).join('') };
  };
  return { ...c, get, ask };
}
const meter = () => monthMeter(A.db.store, monthOf(Date.now()));
const resetMeter = () => A.db.run((s) => { for (const d of s.list(METER)) s.remove(METER, d.id); }, { write: true });
const ledger = () => localUsageLog(A.db).rows({ month: monthOf(Date.now()) });

test('cost math: Claude Haiku 5.5 prices, cache reads and writes, the long-prompt rate card', () => {
  assert.equal(MODEL, 'claude-haiku-5-5');
  const p = PRICES[MODEL];
  assert.deepEqual([p.input, p.output, p.cacheRead, p.cacheWrite], [0.10, 0.50, 0.01, 0.125]);
  assert.equal(costUsd({ inputTokens: 100_000, outputTokens: 0 }), 0.01);
  assert.equal(costUsd({ inputTokens: 0, outputTokens: 1_000_000 }), 0.5);
  assert.equal(costUsd({ inputTokens: 2000, outputTokens: 300, cacheReadTokens: 10_000, cacheWriteTokens: 4000 }), 0.00095); // 0.0002 + 0.00015 + 0.0001 + 0.0005
  assert.equal(costUsd({ inputTokens: 120_000, outputTokens: 1000 }), 0.0625, 'over 100K tokens: the 5x rate card'); // (0.012 + 0.0005) * 5
  assert.equal(costUsd({}), 0);
});

test('complete() for another feature (review replies): no tools, metered and in the ledger without any content', async () => {
  await resetMeter();
  fake.clear();
  fake.reply(text('Thank you so much for the kind words about our patio!', { input_tokens: 900, output_tokens: 40 }));
  await A.db.sync();
  const ai = aiFor({ db: A.db, env: { ANTHROPIC_API_KEY: KEY }, client: fake.client });
  assert.equal(ai.available, true);
  assert.equal(ai.billedTo, 'platform');
  const out = await ai.complete({ purpose: 'review_reply', system: 'You write short, warm replies to restaurant reviews.', messages: [{ role: 'user', content: 'Review: Great patio, slow drinks.' }], maxTokens: 400, user: people.manager });
  assert.equal(out.text, 'Thank you so much for the kind words about our patio!');
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.usage.inputTokens, 900);
  assert.equal(out.usage.costUsd, costUsd({ inputTokens: 900, outputTokens: 40 }));
  const sent = fake.calls[0].params;
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.equal(sent.tools, undefined, 'no tools');
  assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral' }, 'the system prompt is cached');
  assert.equal(sent.output_config.effort, 'low');
  // Metered in the restaurant's store, and in the ledger.
  assert.equal(meter().platformUsd, out.usage.costUsd);
  assert.equal(meter().purposes.review_reply, out.usage.costUsd);
  assert.equal(meter().users[people.manager.id].calls, 1);
  const rows = await ledger();
  const row = rows.find((r) => r.purpose === 'review_reply');
  assert.ok(row, 'a ledger row');
  assert.equal(row.user_id, people.manager.id);
  assert.equal(row.model, 'claude-haiku-5-5');
  assert.equal(row.input_tokens, 900);
  assert.equal(row.billed_to, 'platform');
  assert.equal(row.ok, true);
  assert.ok(!JSON.stringify(rows).includes('patio'), 'no prompt or reply in the ledger');
  // An API failure is metered as an error, with a code only, and comes back as a friendly sentence.
  fake.reply(Object.assign(new Error('upstream exploded with secret details'), { status: 500 }));
  await assert.rejects(ai.complete({ purpose: 'review_reply', messages: [{ role: 'user', content: 'x' }] }), (e) => e instanceof AiUnavailable && e.reason === 'api' && !/secret/.test(e.message));
  const failed = (await ledger()).find((r) => !r.ok);
  assert.equal(failed.error, 'error');
  assert.ok(!JSON.stringify(failed).includes('secret details'));
});

test('the monthly cap: friendly in English and Spanish, never a call; the 80% warning goes to admins once', async () => {
  await resetMeter();
  fake.clear();
  const ai0 = aiFor({ db: A.db, env: { ANTHROPIC_API_KEY: KEY, AI_MONTHLY_CAP_USD: '1' }, client: fake.client });
  assert.equal(ai0.capUsd, 1);
  // 0.79 of $1, then one call of ~$0.02 crosses 80%.
  await A.db.run((s) => s.insert(METER, { id: `month:${monthOf(Date.now())}`, month: monthOf(Date.now()), platformUsd: 0.79, ownUsd: 0, calls: 10, errors: 0, users: {}, purposes: {} }), { write: true });
  fake.reply(text('ok', { input_tokens: 100_000, output_tokens: 20_000 }));
  const before = A.db.store.list('notifications', (n) => n.kind === 'aiUsage').length;
  await aiFor({ db: A.db, env: { ANTHROPIC_API_KEY: KEY, AI_MONTHLY_CAP_USD: '1' }, client: fake.client }).complete({ purpose: 'review_reply', messages: [{ role: 'user', content: 'x' }] });
  const warned = A.db.store.list('notifications', (n) => n.kind === 'aiUsage');
  const admins = A.db.store.list('users', (u) => u.active !== false && ['admin', 'super_admin'].includes(u.role));
  assert.equal(warned.length - before, admins.length, 'every admin gets the 80% warning');
  assert.match(warned[0].i18n.en, /80%|8\d%/);
  assert.match(warned[0].i18n.es, /asignación de IA/);
  // Over the cap: not available, and complete() refuses without calling.
  await A.db.run((s) => s.update(METER, `month:${monthOf(Date.now())}`, { platformUsd: 1.2 }), { write: true });
  const capped = aiFor({ db: A.db, env: { ANTHROPIC_API_KEY: KEY, AI_MONTHLY_CAP_USD: '1' }, client: fake.client });
  assert.equal(capped.available, false);
  assert.equal(capped.reason, 'cap');
  const calls = fake.calls.length;
  await assert.rejects(capped.complete({ purpose: 'review_reply', messages: [{ role: 'user', content: 'x' }], lang: 'es' }), (e) => e.reason === 'cap' && /asignación de IA/.test(e.message));
  assert.equal(fake.calls.length, calls, 'no call over the cap');
  // The warning isn't sent twice in a month.
  assert.equal(A.db.store.list('notifications', (n) => n.kind === 'aiUsage').length, warned.length);
  // A restaurant's own key isn't capped by DubLow's cap; its usage is metered as its own.
  fake.reply(text('ok'));
  const own = aiFor({ db: A.db, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_OWN_API_KEY: 'sk-ant-test-own-placeholder-9999', AI_MONTHLY_CAP_USD: '1' }, client: fake.client });
  assert.equal(own.available, true);
  assert.equal(own.billedTo, 'own');
  const r = await own.complete({ purpose: 'review_reply', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.usage.billedTo, 'own');
  assert.equal(meter().platformUsd, 1.2, 'DubLow’s total unchanged');
  assert.ok(meter().ownUsd > 0);
  assert.equal((await ledger())[0].billed_to, 'own');
  // Through the assistant, the cap is a friendly reply (200), stored as a notice, never an error page.
  const emp = await as('employee');
  const capEnv = A.app; // the app's env has no AI_MONTHLY_CAP_USD: the default ($5) applies
  assert.ok(capEnv);
  await A.db.run((s) => s.update(METER, `month:${monthOf(Date.now())}`, { platformUsd: 5 }), { write: true });
  const n = fake.calls.length;
  const res = await emp.ask('Who’s working tonight?');
  assert.equal(res.status, 200);
  assert.equal(res.done.message.notice, 'cap');
  assert.equal(res.done.message.text, aiMessage('cap', 'en', { restaurant: A.db.store.get('settings', 'settings')?.restaurantName || '' }));
  assert.equal(fake.calls.length, n, 'nothing spent');
  await resetMeter();
});

test('caps per restaurant: the plan’s, DubLow’s override, the default; tenant-env hands over a restaurant’s own key', () => {
  assert.equal(capFor({ plan: 'pro', ai: {} }), 5);
  assert.equal(capFor({ plan: 'beta', ai: {} }), 5);
  assert.equal(capFor({ plan: 'pro', ai: { capUsd: 12.5 } }), 12.5);
  assert.equal(capFor({ plan: 'pro', ai: { capUsd: 0 } }), 0);
  assert.equal(capFor(null, {}), 5);
  assert.equal(resolveFeatures('pro').assistant, true);
  assert.equal(resolveFeatures('beta').assistant, true);
  assert.equal(resolveFeatures('starter').assistant, false);
  const platformEnv = { ANTHROPIC_API_KEY: KEY };
  const t = { id: 'ten_x', is_default: false, name: 'Bistro Test', integrations: {}, resolved: resolveFeatures('pro') };
  assert.equal(tenantEnv(platformEnv, t, {}).ANTHROPIC_OWN_API_KEY, undefined);
  assert.equal(tenantEnv(platformEnv, t, {}).ANTHROPIC_API_KEY, KEY, 'DubLow’s key is platform-wide');
  const withOwn = tenantEnv(platformEnv, t, { ANTHROPIC_OWN_API_KEY: 'sk-ant-test-own-placeholder-9999' });
  assert.equal(withOwn.ANTHROPIC_OWN_API_KEY, 'sk-ant-test-own-placeholder-9999');
  assert.equal(withOwn.ANTHROPIC_API_KEY, KEY, 'next to it, not instead of it');
  // Another restaurant never inherits the default restaurant's own key from env.
  assert.equal(tenantEnv({ ...platformEnv, ANTHROPIC_OWN_API_KEY: 'sk-ant-test-default-own-0000' }, t, {}).ANTHROPIC_OWN_API_KEY, undefined);
  // Settings → Integrations shows it for plans with Ask ShiftBoard: on DubLow's key until the restaurant adds its own.
  const view = restaurantView({ tenant: { ...t, resolved: resolveFeatures('pro') }, secretView: {} });
  assert.equal(view.groups.find((g) => g.key === 'anthropic').status, 'platformKey');
  const set = restaurantView({ tenant: { ...t, resolved: resolveFeatures('pro') }, secretView: { ANTHROPIC_OWN_API_KEY: { set: true, last4: '9999' } } });
  assert.equal(set.groups.find((g) => g.key === 'anthropic').status, 'connected');
  assert.ok(!restaurantView({ tenant: { ...t, resolved: resolveFeatures('starter') }, secretView: {} }).groups.some((g) => g.key === 'anthropic'));
  // The SDK isn't used without a key: no_key.
  assert.equal(aiFor({ db: A.db, env: {} }).reason, 'no_key');
  assert.equal(aiFor({ db: A.db, env: { ANTHROPIC_API_KEY: KEY, AI_DISABLED: 'true' } }).reason, 'off');
  // No AI feature in the plan: 'plan'. Starter has Training, whose smart import reads menus with AI (AI_FEATURES), so
  // it's only 'plan' with Training off too; Ask ShiftBoard itself still needs `assistant` (blocked() in server/assistant/).
  assert.equal(aiFor({ db: A.db, tenant: { plan: 'starter', features: { ...resolveFeatures('starter'), training: false }, ai: {} }, env: { ANTHROPIC_API_KEY: KEY } }).reason, 'plan');
  assert.equal(aiFor({ db: A.db, tenant: { plan: 'starter', features: resolveFeatures('starter'), ai: {} }, env: { ANTHROPIC_API_KEY: KEY } }).reason, undefined);
});

test('the tool loop: reads run as the person, then the answer streams; the system prompt and tools are cached', async () => {
  await resetMeter();
  fake.clear();
  const emp = await as('employee');
  fake.reply(toolUse('get_my_shifts', {}, { say: 'Let me check.' }), text('Your next shift is Friday 4p–10p.'));
  const r = await emp.ask('When do I work next?');
  assert.equal(r.status, 200);
  assert.deepEqual(r.lines.map((l) => l.type).filter((x, i, a) => a.indexOf(x) === i), ['start', 'text', 'status', 'done']);
  assert.equal(r.done.message.text, 'Let me check.\n\nYour next shift is Friday 4p–10p.');
  assert.equal(r.text, r.done.message.text, 'streamed as it came');
  assert.equal(fake.calls.length, 2);
  const [first, second] = fake.calls.map((c) => c.params);
  assert.equal(first.model, 'claude-haiku-5-5');
  assert.deepEqual(first.system[0].cache_control, { type: 'ephemeral' }, 'the rules (and the tools before them) are cached');
  assert.equal(first.system[1].cache_control, undefined, 'who and when come after the breakpoint');
  assert.match(first.system[1].text, new RegExp(people.employee.name));
  assert.match(first.system[1].text, new RegExp(`Today is \\w+, ${todayOf(Date.now())}`));
  assert.deepEqual(first.cache_control, { type: 'ephemeral' }, 'the conversation is cached for the next round');
  assert.deepEqual(first.messages, [{ role: 'user', content: 'When do I work next?' }]);
  // Round two: the whole first answer (thinking block included) and the tool's result as the person.
  assert.equal(second.messages[1].role, 'assistant');
  assert.equal(second.messages[1].content[0].type, 'thinking', 'thinking blocks go back unchanged');
  const result = second.messages[2].content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.is_error, undefined);
  assert.match(result.content, /"shifts"|\[\]/);
  // Metered: two calls, one message today.
  assert.equal(meter().calls, 2);
  assert.equal(meter().users[people.employee.id].messages, 1);
  // The conversation is theirs, and only theirs.
  const list = (await emp.get('/api/assistant')).body.result;
  assert.equal(list.available, true);
  assert.equal(list.conversations[0].id, r.done.conversationId);
  assert.equal(list.today.messages, 1);
  const chat = (await emp.get(`/api/assistant/conversations/${r.done.conversationId}`)).body.result;
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant']);
  const other = await as('employee2');
  assert.equal((await other.get(`/api/assistant/conversations/${r.done.conversationId}`)).status, 404, 'not someone else’s');
  assert.equal((await other.get('/api/assistant')).body.result.conversations.length, 0);
  // A follow-up continues the conversation with what was said (text only).
  fake.reply(text('Yes, 4p.'));
  const again = await emp.ask('Is that 4p?', { conversationId: r.done.conversationId });
  assert.equal(again.done.conversationId, r.done.conversationId);
  assert.deepEqual(fake.calls.at(-1).params.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  // At most six rounds of reads, then a short answer.
  fake.clear();
  for (let i = 0; i < 6; i++) fake.reply(toolUse('get_my_shifts', {}));
  const loop = await emp.ask('Keep checking');
  assert.equal(fake.calls.length, 6);
  assert.equal(loop.done.message.text, aiMessage('loop', 'en'));
  // A refusal: a short, kind answer.
  fake.reply(refusal());
  assert.equal((await emp.ask('Something off-topic')).done.message.text, aiMessage('refusal', 'en'));
  // Clear history.
  const c = await emp.post('/api/assistant/clear', {});
  assert.ok(c.body.result.cleared >= 2);
  assert.equal((await emp.get('/api/assistant')).body.result.conversations.length, 0);
});

test('a change stops the loop and comes back as a card; Confirm runs it once (audited), Cancel doesn’t', async () => {
  fake.clear();
  const mgr = await as('manager');
  const next = addDays(weekStart(todayOf(Date.now()), A.db.store.get('settings', 'settings')?.weekStartDow ?? 1), 7);
  const job = A.db.store.list('jobCodes')[0];
  const draft = await mgr.post('/api/rpc/shifts.save', { date: addDays(next, 2), start: '16:00', end: '22:00', jobCodeId: job.id, userId: null });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const draftId = draft.body.result.shift.id;
  fake.reply(toolUse([['get_schedule', { week: 'next week' }], ['publish_week', { week: 'next week', confirm: true }]], {}, { say: 'I can publish next week’s drafts.' }));
  const r = await mgr.ask('Publish next week');
  assert.equal(fake.calls.length, 1, 'stopped at the change: no second round, nothing run');
  const [card] = r.done.message.actions;
  assert.equal(card.tool, 'publish_week');
  assert.equal(card.status, 'proposed');
  assert.equal(card.title, 'Publish the week');
  assert.deepEqual(card.details[0][0], 'Week');
  assert.match(card.details[0][1], /^Week of /);
  assert.equal(A.db.store.get('shifts', draftId).published, false, 'nothing published by the model');
  // The model never sees confirm in its tools, and writes say they wait for the tap.
  const publish = fake.calls[0].params.tools.find((t) => t.name === 'publish_week');
  assert.equal(publish.input_schema.properties.confirm, undefined);
  assert.match(publish.description, /Confirm/);

  // Someone else can't confirm it.
  const other = await as('admin');
  assert.equal((await other.post(`/api/assistant/actions/${card.id}`, { conversationId: r.done.conversationId, decision: 'confirm' })).status, 404);
  // Confirm: it runs, as the manager, with an audit entry.
  const done = await mgr.post(`/api/assistant/actions/${card.id}`, { conversationId: r.done.conversationId, decision: 'confirm' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.result.ok, true);
  assert.equal(done.body.result.action.status, 'done');
  await A.db.sync();
  assert.equal(A.db.store.get('shifts', draftId).published, true);
  const audit = A.db.store.list('auditLog', (a) => a.action === 'assistant.publish_week');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, people.manager.id);
  assert.equal(audit[0].via, 'assistant');
  assert.deepEqual(audit[0].details.methods, ['shifts.publish']);
  // Twice: no.
  assert.equal((await mgr.post(`/api/assistant/actions/${card.id}`, { conversationId: r.done.conversationId, decision: 'confirm' })).status, 409);
  assert.equal(A.db.store.list('auditLog', (a) => a.action === 'assistant.publish_week').length, 1);

  // Cancel: nothing happens, and the model hears about it next time.
  fake.reply(toolUse('create_shift', { date: addDays(next, 3), start: '17:00', position: job.name }));
  const c = await mgr.ask('Add a shift');
  const card2 = c.done.message.actions[0];
  assert.equal(card2.title, 'Add a draft shift');
  const shiftsBefore = A.db.store.list('shifts').length;
  const cancelled = await mgr.post(`/api/assistant/actions/${card2.id}`, { conversationId: c.done.conversationId, decision: 'cancel' });
  assert.equal(cancelled.body.result.action.status, 'cancelled');
  await A.db.sync();
  assert.equal(A.db.store.list('shifts').length, shiftsBefore);
  fake.reply(text('Okay.'));
  await mgr.ask('Never mind', { conversationId: c.done.conversationId });
  assert.match(JSON.stringify(fake.calls.at(-1).params.messages), /they cancelled it/);

  // A change with bad input goes back to the model, not to a card.
  fake.reply(toolUse('create_shift', { start: '25:99' }), text('Which day?'));
  const bad = await mgr.ask('Add one more');
  assert.equal(bad.done.message.actions, undefined);
  assert.equal(fake.calls.at(-1).params.messages.at(-1).content[0].is_error, true);
});

test('permissions: an employee gets an employee’s tools; Roles & features and the restaurant’s switches apply', async () => {
  fake.clear();
  const emp = await as('employee');
  fake.reply(text('Hi'));
  await emp.ask('Hi');
  const names = fake.calls[0].params.tools.map((t) => t.name);
  for (const n of ['whoami', 'get_my_shifts', 'who_is_working', 'request_time_off', 'get_86_list']) assert.ok(names.includes(n), n);
  for (const n of ['publish_week', 'create_shift', 'get_team', 'get_labor_summary', 'approve_request']) assert.ok(!names.includes(n), `${n} is for managers`);
  // The same list, in the same order, every time (so it stays cached).
  assert.deepEqual(claudeTools(TOOLS.filter((t) => names.includes(t.name))), fake.calls[0].params.tools);

  // Even a forged confirm of a manager's tool fails as the employee.
  const fakeChat = await A.db.run((s) => s.insert('assistantChats', { id: 'ach_forged', userId: people.employee.id, title: 't', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: 'acm_1', role: 'assistant', text: '', at: new Date().toISOString(), actions: [{ id: 'act_forged', tool: 'publish_week', args: { week: 'this week' }, title: 'x', details: [], status: 'proposed', expiresAt: new Date(Date.now() + 60_000).toISOString() }] }] }), { write: true });
  const forged = await emp.post(`/api/assistant/actions/act_forged`, { conversationId: fakeChat.id, decision: 'confirm' });
  assert.equal(forged.body.result.ok, false);
  assert.equal(forged.body.result.action.status, 'failed');
  assert.equal(A.db.store.list('auditLog', (a) => a.action === 'assistant.publish_week' && a.actorId === people.employee.id).length, 0);

  // Roles & features: off for employees → refused, nothing spent.
  const admin = await as('admin');
  assert.equal((await admin.post('/api/rpc/roleFeatures.save', { roleFeatures: { employee: { assistant: false } } })).status, 200);
  assert.equal((await emp.post('/api/rpc/app.bootstrap', {})).body.result.features.assistant, false, 'the apps hide it');
  const n = fake.calls.length;
  const off = await emp.ask('Hi');
  assert.equal(off.status, 403);
  assert.equal(off.body.reason, 'role');
  assert.equal(fake.calls.length, n);
  await admin.post('/api/rpc/roleFeatures.save', { roleFeatures: { employee: { assistant: true } } });

  // Settings → Ask ShiftBoard: staff off, then off for everyone.
  const s0 = await admin.get('/api/assistant/settings');
  assert.equal(s0.status, 200);
  assert.equal(s0.body.result.enabled, true);
  assert.equal((await emp.get('/api/assistant/settings')).status, 403, 'admins only');
  await admin.post('/api/assistant/settings', { staff: false });
  assert.equal((await emp.ask('Hi')).done.message.notice, 'staff');
  assert.equal((await emp.get('/api/assistant')).body.result.reason, 'staff');
  fake.reply(text('Hi manager'));
  assert.equal((await (await as('manager')).ask('Hi')).done.message.text, 'Hi manager', 'managers still can');
  await admin.post('/api/assistant/settings', { enabled: false, staff: true });
  assert.equal((await emp.ask('Hi')).done.message.notice, 'off');
  await admin.post('/api/assistant/settings', { enabled: true });
  assert.ok(A.db.store.list('auditLog', (a) => a.action === 'assistant.settings').length >= 3);
  // Usage for admins: this month vs the cap, and the top people (names, not message content).
  const view = (await admin.get('/api/assistant/settings')).body.result;
  assert.equal(view.usage.capUsd, 5);
  assert.ok(Array.isArray(view.top) && view.top.length <= 5);
  assert.ok(view.top.every((p) => p.name && typeof p.usd === 'number'));
});

test('the daily message limit and the per-minute limit: friendly, and nothing spent', async () => {
  await resetMeter();
  const B = await startApp({ env: { ANTHROPIC_API_KEY: KEY, AI_DAILY_MESSAGES: '2', AI_MESSAGES_PER_MINUTE: '100' }, aiClient: fake.factory });
  try {
    const pick = (role) => B.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[0];
    const c = jsonClient(B.base);
    assert.equal((await signIn(c.post, pick('employee').email)).status, 200);
    const ask = async (message) => (await c.post('/api/assistant', { message, stream: false })).body.result;
    fake.clear();
    fake.reply(text('one'), text('two'));
    assert.equal((await ask('1')).message.text, 'one', 'stream: false answers in JSON (the phone app)');
    assert.equal((await ask('2')).message.text, 'two');
    const third = await ask('3');
    assert.equal(third.message.notice, 'daily');
    assert.match(third.message.text, /2 messages/);
    assert.equal(fake.calls.length, 2, 'the third was never sent');
  } finally { await B.close(); }
  const C = await startApp({ env: { ANTHROPIC_API_KEY: KEY, AI_MESSAGES_PER_MINUTE: '1' }, aiClient: fake.factory });
  try {
    const pick = (role) => C.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[0];
    const c = jsonClient(C.base);
    assert.equal((await signIn(c.post, pick('employee').email)).status, 200);
    fake.clear();
    fake.reply(text('one'));
    assert.equal((await c.post('/api/assistant', { message: '1', stream: false })).body.result.message.text, 'one');
    assert.equal((await c.post('/api/assistant', { message: '2', stream: false })).body.result.message.notice, 'rate');
  } finally { await C.close(); }
});

test('View as: no assistant while viewing, nothing spent, nobody else’s conversations', async () => {
  fake.clear();
  const boss = await as('owner');
  const emp = await as('employee');
  fake.reply(text('Private answer'));
  const mine = await emp.ask('Something private');
  assert.equal((await boss.post('/api/view-as/start', { userId: people.employee.id })).status, 200);
  const status = (await boss.get('/api/assistant')).body.result;
  assert.equal(status.available, false);
  assert.equal(status.viewAs, true);
  assert.deepEqual(status.conversations, [], 'the viewed person’s conversations stay theirs');
  assert.match(status.message, /viewing/);
  assert.equal((await boss.get(`/api/assistant/conversations/${mine.done.conversationId}`)).status, 404);
  const n = fake.calls.length;
  const r = await boss.ask('Who’s working tonight?');
  assert.equal(r.status, 403);
  assert.equal(r.body.viewAs, true);
  assert.equal((await boss.post('/api/assistant/clear', {})).status, 403);
  assert.equal(fake.calls.length, n, 'nothing spent');
  await boss.post('/api/view-as/stop', {});
});

test('Spanish: the person’s language in the prompt, the cards and the friendly messages', async () => {
  fake.clear();
  const mgr = await as('manager');
  await mgr.post('/api/rpc/account.preferences', { language: 'es' });
  fake.reply(toolUse('request_time_off', { startDate: 'tomorrow', reason: 'Cita médica' }));
  const r = await mgr.ask('Quiero pedir mañana libre');
  assert.match(fake.calls[0].params.system[1].text, /Language: Spanish/);
  const card = r.done.message.actions[0];
  assert.equal(card.title, 'Pedir días libres');
  assert.deepEqual(card.details.map(([k]) => k), ['Desde', 'Motivo']);
  assert.equal(aiMessage('daily', 'es', { limit: 50 }).startsWith('Hoy ya enviaste 50 mensajes'), true);
  assert.equal(describeAction(toolByName('report_86_item'), { item: 'Limones', status: 'out' }, 'es').details[1][1], 'Se acabó (86)');
  // Cancel it, and switch back.
  await mgr.post(`/api/assistant/actions/${card.id}`, { conversationId: r.done.conversationId, decision: 'cancel' });
  await mgr.post('/api/rpc/account.preferences', { language: '' });
});
