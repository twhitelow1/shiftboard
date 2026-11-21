// Training: menu study guide visibility, photos, quizzes (generation and server-side grading), the leaderboard,
// the employee manual and the manager on duty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { PHOTO_MAX_BYTES, PHOTOS_PER_ITEM, localizeItem, localize, allergenLabel, canonicalAllergen, TEXT } from '../core/training.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';

function prng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A small restaurant: managers, a chef, a supervisor, and staff in the dining room, the bar and the kitchen.
function fresh() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test Bistro', departments: ['Leadership', 'Restaurant', 'Bar', 'Kitchen'], areas: ['Dining Room', 'Patio'] });
  const job = (id, name, department, defaultRole = 'employee') => store.insert('jobCodes', { id, name, short: name.slice(0, 3).toUpperCase(), department, defaultRole, order: 0, archived: false });
  job('job_mgr', 'Manager', 'Leadership', 'manager');
  job('job_chef', 'Chef', 'Leadership', 'manager');
  job('job_srv', 'Server', 'Restaurant');
  job('job_bar', 'Bartender', 'Bar');
  job('job_cook', 'Line Cook', 'Kitchen');
  const user = (id, role, jobs, extra = {}) => store.insert('users', { id, name: id, role, active: true, email: `${id}@test.local`, phone: '', availability: {},
    jobCodes: jobs.map(([jobCodeId, areas]) => ({ jobCodeId, ...(areas ? { areas } : {}) })), ...extra });
  user('admin', 'admin', [['job_mgr']], { phone: '555-0100-1' });
  user('mgrA', 'manager', [['job_mgr']], { phone: '(555) 010-1111' });
  user('mgrB', 'manager', [['job_mgr']], { phone: '(555) 010-2222' });
  user('chef', 'manager', [['job_chef']], { phone: '(555) 010-3333' });
  user('sup', 'supervisor', [['job_srv', ['Dining Room']]], { phone: '(555) 010-4444' });
  user('srv', 'employee', [['job_srv', ['Patio']]], { phone: '(555) 010-5555' });
  user('srv2', 'employee', [['job_srv', ['Dining Room']]]);
  user('bar', 'employee', [['job_bar', ['Dining Room']]], { phone: '(555) 010-6666' });
  user('cook', 'employee', [['job_cook']], { phone: '(555) 010-7777' });
  user('esp', 'employee', [['job_srv']], { language: 'es' });
  const clock = { now: new Date('2026-11-20T12:00:00') }; // a Friday
  const svc = createService(store, { now: () => clock.now, random: prng(7) });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  return { store, svc, clock, as, admin: as('admin'), mgr: as('mgrA') };
}

const ITEMS = [
  { name: 'Fries', category: 'Sides', keyIngredients: 'potatoes, sea salt', allergens: [], dietary: ['vegan'],
    recipe: { yield: '1 basket', ingredients: [{ qty: '1 lb', item: 'secret seasoning' }, { qty: '8 oz', item: 'potatoes' }], steps: ['SECRET STEP fry twice'] },
    prep: { notes: 'SECRET PREP blanch at 300' }, selling: { notes: 'Upsell truffle', pairings: 'Beer' },
    es: { name: 'Papas', recipe: { ingredients: [{ qty: '1 lb', item: 'condimento secreto' }], steps: ['PASO SECRETO'] }, prep: { notes: 'PREPARACION SECRETA' }, selling: { notes: 'Ofrece trufa' } } },
  { name: 'Margarita', category: 'Cocktails', keyIngredients: ['tequila', 'lime'], allergens: [], recipe: { ingredients: [{ qty: '2 oz', item: 'tequila' }, { qty: '1 oz', item: 'house agave mix' }], steps: ['Shake'] } },
  { name: 'Caesar', category: 'Starters', keyIngredients: 'romaine, parmesan, anchovy', allergens: ['fish', 'Eggs', 'dairy', 'wheat'] },
  { name: 'Brownie', category: 'Desserts', keyIngredients: 'chocolate, walnuts', allergens: ['milk', 'eggs', 'wheat', 'Tree Nuts'] },
  { name: 'Steak', category: 'Mains', keyIngredients: 'ribeye, butter', allergens: ['milk'] },
  { name: 'Old Special', category: 'Mains', keyIngredients: 'mystery', allergens: [], eightySixed: true },
];
function withMenu() {
  const f = fresh();
  f.items = Object.fromEntries(ITEMS.map((it) => [it.name, f.admin('menu.save', it)]));
  return f;
}
const SECRETS = ['secret seasoning', 'SECRET STEP', 'SECRET PREP', 'house agave mix', 'condimento secreto', 'PASO SECRETO', 'PREPARACION SECRETA'];
const leaks = (value) => SECRETS.filter((s) => JSON.stringify(value).includes(s));
const tinyJpeg = (bytes = 200) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes - 4, 7)]).toString('base64')}`;

// ---------- visibility ----------

test('recipes and prep notes go to the kitchen and bar (and managers), never to front-of-house through any RPC', () => {
  const f = withMenu();
  const fries = f.items.Fries.id;
  const srv = f.as('srv'), bar = f.as('bar'), cook = f.as('cook');

  const asServer = srv('menu.list');
  const friesForServer = asServer.items.find((i) => i.id === fries);
  assert.deepEqual(friesForServer.can, { selling: true, recipe: false, prep: false });
  assert.equal(friesForServer.recipe, undefined);
  assert.equal(friesForServer.prep, undefined);
  assert.equal(friesForServer.es.recipe, undefined, 'the Spanish recipe is hidden too');
  assert.equal(friesForServer.selling.notes, 'Upsell truffle');
  assert.equal(friesForServer.visibility, undefined, 'staff don’t get the visibility rules');

  // Every read a server can make, plus quizzes made of ingredient questions, carries none of it.
  const quiz = f.admin('quiz.save', { title: 'Ingredients', types: ['ingredient', 'custom'], count: 10 });
  f.admin('quiz.saveQuestion', { kind: 'mc', text: 'How much secret seasoning?', choices: ['1 lb', '2 lb'], correct: 0, itemId: fries, audience: 'recipe' });
  const reads = [srv('menu.list'), srv('menu.get', { id: fries }), srv('training.summary'), srv('quiz.list'), srv('training.settings.get'), srv('leaderboard.get', {})];
  for (let i = 0; i < 15; i++) {
    const att = srv('quiz.start', { quizId: quiz.id, fresh: true });
    reads.push(att, srv('quiz.submit', { attemptId: att.id }));
  }
  assert.deepEqual(leaks(reads), []);
  assert.throws(() => srv('quiz.questions.list'), /Managers only/);
  assert.throws(() => srv('menu.save', { name: 'x' }), /Managers only/);

  // Kitchen and bar see recipe and prep; their quizzes can use recipe ingredients.
  for (const who of [bar, cook]) {
    const it = who('menu.get', { id: fries });
    assert.deepEqual(it.can, { selling: true, recipe: true, prep: true });
    assert.equal(it.recipe.ingredients[0].item, 'secret seasoning');
    assert.equal(it.prep.notes, 'SECRET PREP blanch at 300');
  }
  let sawRecipeIngredient = false;
  for (let i = 0; i < 15 && !sawRecipeIngredient; i++) sawRecipeIngredient = JSON.stringify(cook('quiz.start', { quizId: quiz.id, fresh: true })).includes('secret seasoning');
  assert.ok(sawRecipeIngredient, 'kitchen quizzes may ask about recipe ingredients');

  // Managers and up always see everything.
  const asMgr = f.mgr('menu.get', { id: fries });
  assert.deepEqual(asMgr.can, { selling: true, recipe: true, prep: true });
  assert.equal(asMgr.es.prep.notes, 'PREPARACION SECRETA');
});

test('each item can change who sees each group, and admins can change the restaurant default', () => {
  const f = withMenu();
  const marg = f.items.Margarita;
  // Recipe for everyone on this one item; selling notes for the bar only.
  f.admin('menu.save', { ...marg, visibility: { recipe: { all: true }, selling: { departments: ['Bar'] } } });
  assert.equal(f.as('srv')('menu.get', { id: marg.id }).recipe.ingredients[1].item, 'house agave mix');
  assert.equal(f.as('srv')('menu.get', { id: marg.id }).selling, undefined);
  // A rule by job code.
  f.admin('menu.save', { ...marg, visibility: { recipe: { departments: [], jobCodeIds: ['job_srv'] } } });
  assert.ok(f.as('srv')('menu.get', { id: marg.id }).recipe);
  assert.equal(f.as('cook')('menu.get', { id: marg.id }).recipe, undefined, 'the item’s own rule replaces the default');

  // Restaurant default: prep notes for everyone; recipes for the kitchen only.
  assert.throws(() => f.mgr('training.saveSettings', { defaults: {} }), /Admins only/);
  f.admin('training.saveSettings', { defaults: { prep: { all: true }, recipe: { departments: ['Kitchen'] } } });
  const fries = f.as('srv')('menu.get', { id: f.items.Fries.id });
  assert.equal(fries.prep.notes, 'SECRET PREP blanch at 300');
  assert.equal(fries.recipe, undefined);
  assert.equal(f.as('bar')('menu.get', { id: f.items.Fries.id }).recipe, undefined);
  assert.ok(f.as('cook')('menu.get', { id: f.items.Fries.id }).recipe);
});

test('menu items: allergens are normalized, sections ordered, 86’d kept but flagged', () => {
  const f = withMenu();
  const list = f.as('srv')('menu.list');
  assert.deepEqual(list.items.find((i) => i.name === 'Caesar').allergens, ['fish', 'eggs', 'milk', 'wheat']);
  assert.deepEqual(list.items.find((i) => i.name === 'Brownie').allergens, ['milk', 'eggs', 'wheat', 'tree nuts']);
  assert.deepEqual(list.categories, ['Starters', 'Mains', 'Sides', 'Desserts', 'Cocktails']);
  assert.equal(list.items.find((i) => i.name === 'Old Special').eightySixed, true);
  assert.equal(canonicalAllergen('Cacahuate'), 'peanuts');
  assert.equal(canonicalAllergen('Sulfites'), 'sulfites', 'custom allergens are kept');
  assert.equal(allergenLabel('tree nuts', 'es'), 'Nueces de árbol');
  assert.equal(allergenLabel('sesame', 'es'), 'Ajonjolí');
  assert.throws(() => f.admin('menu.save', { name: '' }), /Name is required/);
  assert.throws(() => f.admin('menu.save', { name: 'X', price: 'cheap' }), /Price/);
});

test('Spanish: managers add Spanish versions; Spanish speakers read them, with English where there is none', () => {
  const f = withMenu();
  const fries = f.as('cook')('menu.get', { id: f.items.Fries.id });
  const es = localizeItem(fries, 'es');
  assert.equal(es.name, 'Papas');
  assert.equal(es.recipe.ingredients[0].item, 'condimento secreto');
  assert.equal(es.prep.notes, 'PREPARACION SECRETA');
  assert.equal(es.description, fries.description, 'no Spanish description: English');
  assert.equal(es.recipe.yield, '1 basket');
  assert.equal(localizeItem(fries, 'en').name, 'Fries');
  assert.deepEqual(localize({ title: 'Call-out', body: 'Call', es: { title: 'Avisos', body: '' } }, 'es'), { title: 'Avisos', body: 'Call', es: { title: 'Avisos', body: '' } });

  // Generated questions use the Spanish templates and allergen names.
  const quiz = f.admin('quiz.save', { title: 'Alérgenos', types: ['allergen', 'category'], count: 20, es: { title: 'Alérgenos ES' } });
  const att = f.as('esp')('quiz.start', { quizId: quiz.id });
  assert.equal(att.title, 'Alérgenos ES');
  const prompts = att.questions.map((q) => q.prompt);
  assert.ok(prompts.some((p) => p.startsWith('¿Qué alérgeno contiene')));
  assert.ok(prompts.some((p) => p.startsWith('¿En qué parte del menú está')));
  const choices = att.questions.flatMap((q) => q.choices.map((c) => c.text));
  assert.ok(choices.some((c) => ['Leche', 'Huevo', 'Pescado', 'Trigo', 'Mariscos', 'Soya', 'Ajonjolí', 'Nueces de árbol', 'Cacahuate (maní)', 'Verdadero'].includes(c)));
  assert.ok(choices.includes('Postres') || choices.includes('Entradas') || choices.includes('Platos fuertes'), 'built-in Spanish section names');
  assert.ok(!choices.includes('Milk'));
  assert.equal(typeof TEXT.es.qPhoto, 'string');
});

// ---------- photos ----------

test('photos: managers only, JPEG/PNG/WebP that really are images, under the size limit, up to 8 an item; reorder and delete', () => {
  const f = withMenu();
  const itemId = f.items.Steak.id;
  assert.throws(() => f.as('srv')('menu.addPhoto', { itemId, dataUrl: tinyJpeg() }), /Managers only/);
  assert.throws(() => f.mgr('menu.addPhoto', { itemId, dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }), /JPG, PNG or WebP/);
  assert.throws(() => f.mgr('menu.addPhoto', { itemId, dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }), /JPG, PNG or WebP/);
  assert.throws(() => f.mgr('menu.addPhoto', { itemId, dataUrl: `data:image/png;base64,${Buffer.alloc(200, 1).toString('base64')}` }), /isn’t the kind of image/);
  const big = tinyJpeg(PHOTO_MAX_BYTES + 1);
  assert.throws(() => f.mgr('menu.addPhoto', { itemId, dataUrl: big }), (e) => e.status === 413 && /too large/.test(e.message));
  f.mgr('menu.addPhoto', { itemId, dataUrl: tinyJpeg(PHOTO_MAX_BYTES) }); // right at the limit is fine
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(100, 1)]);
  f.mgr('menu.addPhoto', { itemId, dataUrl: `data:image/webp;base64,${webp.toString('base64')}`, w: 1200, h: 900 });
  for (let i = 2; i < PHOTOS_PER_ITEM; i++) f.mgr('menu.addPhoto', { itemId, dataUrl: tinyJpeg() });
  assert.throws(() => f.mgr('menu.addPhoto', { itemId, dataUrl: tinyJpeg() }), /up to 8 photos/);

  const photos = f.as('srv')('menu.get', { id: itemId }).photos;
  assert.equal(photos.length, PHOTOS_PER_ITEM);
  assert.deepEqual(photos[1], { id: photos[1].id, w: 1200, h: 900 });
  assert.ok(!('data' in photos[0]), 'the menu list carries ids, not the photos themselves');
  const reversed = photos.map((p) => p.id).reverse();
  assert.deepEqual(f.mgr('menu.reorderPhotos', { itemId, photoIds: reversed }).photos.map((p) => p.id), reversed);
  assert.throws(() => f.mgr('menu.reorderPhotos', { itemId, photoIds: reversed.slice(1) }), /don’t match/);
  f.mgr('menu.removePhoto', { itemId, photoId: reversed[0] });
  assert.equal(f.store.get('menuPhotos', reversed[0]), null);
  assert.equal(f.mgr('menu.get', { id: itemId }).photos.length, PHOTOS_PER_ITEM - 1);
  assert.match(f.as('srv')('menu.photo.get', { id: reversed[1] }).dataUrl, /^data:image\/jpeg;base64,/);
  assert.throws(() => f.svc.call(null, 'menu.photo.get', { id: reversed[1] }), /sign in/);

  f.mgr('menu.delete', { id: itemId });
  assert.equal(f.store.list('menuPhotos').length, 0, 'deleting an item deletes its photos');
});

// ---------- quizzes ----------

test('quiz generation: question count, types, choices, 86’d items left out, custom questions in scope', () => {
  const f = withMenu();
  f.mgr('menu.addPhoto', { itemId: f.items.Steak.id, dataUrl: tinyJpeg() });
  const tf = f.mgr('quiz.saveQuestion', { kind: 'tf', text: 'Steak is cooked to order.', correct: true, itemId: f.items.Steak.id });
  const general = f.mgr('quiz.saveQuestion', { kind: 'mc', text: 'What does 86 mean?', choices: ['Out of it', 'Table of 86', '', 'Ready'], correct: 0 });
  assert.deepEqual(general.choices, ['Out of it', 'Table of 86', 'Ready'], 'blank answers are dropped');
  assert.throws(() => f.mgr('quiz.saveQuestion', { kind: 'mc', text: 'Q', choices: ['only one'], correct: 0 }), /two answers/);

  const all = f.mgr('quiz.save', { title: 'Everything', count: 50, questionIds: [general.id] });
  const att = f.as('srv')('quiz.start', { quizId: all.id });
  const types = new Set(att.questions.map((q) => q.type));
  for (const t of ['photo', 'allergen', 'ingredient', 'category', 'custom']) assert.ok(types.has(t), `has ${t} questions`);
  assert.ok(!att.questions.some((q) => q.prompt.includes('Old Special')), '86’d items aren’t asked about');
  for (const q of att.questions) {
    assert.ok(q.choices.length >= 2 && q.choices.length <= 4, q.prompt);
    assert.equal(new Set(q.choices.map((c) => c.text.toLowerCase())).size, q.choices.length, `no duplicate answers: ${q.prompt}`);
    assert.equal(q.correctId, undefined, 'no answers before answering');
  }
  assert.equal(att.questions.filter((q) => q.type === 'photo').length, 1, 'only items with photos get photo questions');
  assert.ok(att.questions.some((q) => q.prompt === tf.text) && att.questions.some((q) => q.prompt === general.text));
  assert.ok(att.questions.find((q) => q.prompt === 'Which allergen is in Caesar?'));
  assert.ok(att.questions.find((q) => q.prompt === 'True or false: Fries has none of the 9 major allergens.'));

  // Count and scope.
  const desserts = f.mgr('quiz.save', { title: 'Desserts', categories: ['Desserts'], count: 2, types: ['allergen', 'category'] });
  const d = f.as('srv')('quiz.start', { quizId: desserts.id });
  assert.equal(d.questions.length, 2);
  assert.ok(d.questions.every((q) => q.prompt.includes('Brownie')));
  // Coming back resumes the same try; fresh starts over.
  assert.equal(f.as('srv')('quiz.start', { quizId: desserts.id }).id, d.id);
  assert.notEqual(f.as('srv')('quiz.start', { quizId: desserts.id, fresh: true }).id, d.id);
  // A quiz with nothing to ask.
  const empty = f.mgr('quiz.save', { title: 'Nothing', categories: ['Brunch'], types: ['photo'] });
  assert.throws(() => f.as('srv')('quiz.start', { quizId: empty.id }), /no questions yet/);
});

test('grading happens on the server; answers only come back once a question (or the quiz) is answered', () => {
  const f = withMenu();
  const each = f.mgr('quiz.save', { title: 'Each', count: 5, types: ['allergen', 'category'], feedback: 'each', passingScore: 60 });
  const srv = f.as('srv');
  const att = srv('quiz.start', { quizId: each.id });
  assert.ok(att.questions.every((q) => !('correctId' in q) && !('correct' in q) && !('itemId' in q)));
  const truth = f.store.get('quizAttempts', att.id).questions;

  // "each": answering reveals that one question only, and it can't be changed after.
  const q1 = att.questions[0];
  const wrong = q1.choices.find((c) => c.id !== truth[0].correctId).id;
  const r = srv('quiz.answer', { attemptId: att.id, key: q1.key, choiceId: wrong });
  assert.deepEqual([r.correct, r.correctId], [false, truth[0].correctId]);
  assert.throws(() => srv('quiz.answer', { attemptId: att.id, key: q1.key, choiceId: truth[0].correctId }), /already answered/);
  assert.throws(() => srv('quiz.answer', { attemptId: att.id, key: att.questions[1].key, choiceId: 'z' }), /Pick one/);
  const mid = srv('quiz.attempt.get', { id: att.id });
  assert.equal(mid.questions[0].correctId, truth[0].correctId);
  assert.ok(mid.questions.slice(1).every((q) => q.correctId === undefined), 'unanswered questions stay hidden');

  // Someone else can't read or answer it; a manager can read it.
  assert.throws(() => f.as('srv2')('quiz.attempt.get', { id: att.id }), /not found/);
  assert.throws(() => f.as('srv2')('quiz.answer', { attemptId: att.id, key: q1.key, choiceId: 'a' }), /not found/);
  assert.equal(f.mgr('quiz.attempt.get', { id: att.id }).id, att.id);
  assert.throws(() => f.mgr('quiz.submit', { attemptId: att.id }), /not found/, 'managers can’t hand in someone else’s quiz');

  // Hand in the rest right (the client can't pick the score).
  const answers = Object.fromEntries(truth.slice(1).map((q) => [q.key, q.correctId]));
  const done = srv('quiz.submit', { attemptId: att.id, answers, score: 100, pct: 100, passed: true });
  assert.equal(done.score, 4);
  assert.equal(done.pct, 80);
  assert.equal(done.passed, true);
  assert.ok(done.questions.every((q) => q.correctId));
  assert.equal(done.questions[0].correct, false, 'the first answer stays wrong');
  assert.throws(() => srv('quiz.submit', { attemptId: att.id, answers }), /already handed in/);
  assert.throws(() => srv('quiz.answer', { attemptId: att.id, key: q1.key, choiceId: 'a' }), /already handed in/);

  // "end": nothing comes back until it's handed in; answers can change until then.
  const end = f.mgr('quiz.save', { title: 'End', count: 4, types: ['category'], feedback: 'end', passingScore: 100 });
  const e = srv('quiz.start', { quizId: end.id });
  const eTruth = f.store.get('quizAttempts', e.id).questions;
  const saved = srv('quiz.answer', { attemptId: e.id, key: e.questions[0].key, choiceId: e.questions[0].choices[0].id });
  assert.deepEqual(saved, { key: e.questions[0].key, saved: true });
  assert.ok(srv('quiz.attempt.get', { id: e.id }).questions.every((q) => q.correctId === undefined));
  const out = srv('quiz.submit', { attemptId: e.id, answers: { [eTruth[0].key]: eTruth[0].correctId, [eTruth[1].key]: eTruth[1].correctId } });
  assert.deepEqual([out.score, out.total, out.pct, out.passed], [2, eTruth.length, 50, false]);

  assert.deepEqual(srv('quiz.attempts.list').map((t) => t.pct).sort(), [50, 80]);
  assert.throws(() => f.as('srv2')('quiz.attempts.list', { userId: 'srv' }), /Managers only/);
  const row = srv('quiz.list').find((q) => q.id === each.id);
  assert.deepEqual([row.my.attempts, row.my.best, row.my.passed], [1, 80, true]);
});

test('quiz photos are served by attempt and question, so the photo doesn’t give the answer away', () => {
  const f = withMenu();
  f.mgr('menu.addPhoto', { itemId: f.items.Steak.id, dataUrl: tinyJpeg() });
  const quiz = f.mgr('quiz.save', { title: 'Photos', types: ['photo'], count: 5 });
  const att = f.as('srv')('quiz.start', { quizId: quiz.id });
  const q = att.questions[0];
  assert.deepEqual([q.type, q.photo, q.photoId], ['photo', true, undefined]);
  assert.match(f.as('srv')('quiz.photo.get', { attemptId: att.id, key: q.key }).dataUrl, /^data:image\/jpeg/);
  assert.throws(() => f.as('srv2')('quiz.photo.get', { attemptId: att.id, key: q.key }), /not found/);
});

test('assigning a quiz with a due date notifies the people in those positions', () => {
  const f = withMenu();
  const quiz = f.mgr('quiz.save', { title: 'Server basics', jobCodeIds: ['job_srv'], dueDate: '2026-12-01', es: { title: 'Básico para meseros' } });
  const notes = (id) => f.store.list('notifications', (n) => n.userId === id).map((n) => n.text);
  assert.deepEqual(notes('srv'), ['New quiz for you: Server basics, due Tue, Dec 1.']);
  assert.deepEqual(notes('esp'), ['Tienes un nuevo cuestionario: Básico para meseros, para el mar 1 dic.'], 'in their language');
  assert.deepEqual(notes('bar'), []);
  f.mgr('quiz.save', { ...quiz, dueDate: '2026-12-05' });
  assert.equal(notes('srv').length, 2);
  assert.match(notes('srv')[1], /now due Sat, Dec 5/);
  assert.deepEqual(f.as('srv')('training.summary').quizzes.map((q) => q.title), ['Server basics']);
  assert.deepEqual(f.as('bar')('training.summary').quizzes, []);
});

// ---------- leaderboard ----------

function addAttempt(store, userId, quizId, results, passingScore = 80) {
  const questions = results.map(([itemId, ok], i) => ({ key: `q${i + 1}`, itemId, itemName: itemId, category: '', choices: [{ id: 'a' }, { id: 'b' }], correctId: 'a', answerId: ok ? 'a' : 'b' }));
  const score = results.filter(([, ok]) => ok).length;
  const pct = Math.round((score * 100) / results.length);
  return store.insert('quizAttempts', { quizId, userId, title: quizId, feedback: 'end', passingScore, startedAt: '2026-11-01T10:00:00Z', submittedAt: `2026-11-0${store.list('quizAttempts').length % 9 + 1}T10:00:00Z`, questions, score, total: results.length, pct, passed: pct >= passingScore });
}

test('leaderboard: best, average, passed and mastered; ties share a rank; filters; managers see who hasn’t started', () => {
  const f = withMenu();
  const [fries, caesar, steak] = [f.items.Fries.id, f.items.Caesar.id, f.items.Steak.id];
  const s = f.store;
  // srv: quiz1 50% then 100%, quiz2 75% → best avg(100, 75) = 88, avg (50 + 100 + 75) / 3 = 75, passed 1.
  addAttempt(s, 'srv', 'q1', [[fries, true], [caesar, false], [fries, false], [steak, true]]);
  addAttempt(s, 'srv', 'q1', [[fries, true], [caesar, true], [fries, true], [steak, true]]);
  addAttempt(s, 'srv', 'q2', [[caesar, true], [caesar, true], [steak, false], [steak, true]]);
  // Mastered: fries 3/4 = 75% (no), caesar 3/4 = 75% (no), steak 3/4 (no) — then bar: fries 2/2 (yes), caesar 1/1 (too few).
  addAttempt(s, 'bar', 'q1', [[fries, true], [fries, true], [caesar, true], [steak, false]]);
  addAttempt(s, 'cook', 'q1', [[fries, true], [fries, true], [caesar, true], [steak, false]]);

  const lb = f.as('srv')('leaderboard.get', {});
  assert.equal(lb.visible, true);
  const row = (id) => lb.rows.find((r) => r.userId === id);
  assert.deepEqual([row('srv').best, row('srv').avg, row('srv').passed, row('srv').mastered, row('srv').attempts], [88, 75, 1, 0, 3]);
  assert.deepEqual([row('bar').best, row('bar').avg, row('bar').passed, row('bar').mastered], [75, 75, 0, 1]);
  assert.deepEqual(lb.rows.map((r) => [r.userId, r.rank]), [['srv', 1], ['bar', 2], ['cook', 2]], 'same numbers, same rank');
  assert.equal(lb.notStarted, undefined, 'staff don’t get the not-started list');

  const byMastered = f.mgr('leaderboard.get', { sort: 'mastered' });
  assert.deepEqual(byMastered.rows.map((r) => r.userId), ['bar', 'cook', 'srv']);
  assert.ok(byMastered.notStarted.some((p) => p.userId === 'srv2'));
  assert.deepEqual(f.mgr('leaderboard.get', { jobCodeId: 'job_bar' }).rows.map((r) => r.userId), ['bar']);
  assert.deepEqual(f.mgr('leaderboard.get', { department: 'Kitchen' }).rows.map((r) => r.userId), ['cook']);
  assert.deepEqual(f.mgr('leaderboard.get', { area: 'Patio' }).rows.map((r) => r.userId), ['srv']);
  assert.deepEqual(lb.filters.areas, ['Dining Room', 'Patio']);

  // Per-person detail: weakest first. Managers for anyone, staff for themselves only.
  const detail = f.mgr('leaderboard.person.get', { userId: 'srv' });
  assert.deepEqual(detail.items.map((i) => [i.name, i.answered, i.correct, i.pct]), [['Fries', 4, 3, 75], ['Caesar', 4, 3, 75], ['Steak', 4, 3, 75]]);
  assert.deepEqual(detail.categories.map((c) => c.category).sort(), ['Mains', 'Sides', 'Starters']);
  assert.equal(f.as('srv')('leaderboard.person.get', {}).user.id, 'srv');
  assert.throws(() => f.as('srv')('leaderboard.person.get', { userId: 'bar' }), /Managers only/);
});

test('leaderboard switch: managers only hides other people from staff', () => {
  const f = withMenu();
  addAttempt(f.store, 'srv', 'q1', [[f.items.Fries.id, true]]);
  addAttempt(f.store, 'bar', 'q1', [[f.items.Fries.id, false]]);
  assert.throws(() => f.mgr('training.saveSettings', { leaderboard: 'managers' }), /Admins only/);
  f.admin('training.saveSettings', { leaderboard: 'managers' });
  const staff = f.as('bar')('leaderboard.get', {});
  assert.equal(staff.visible, false);
  assert.equal(staff.rows, undefined);
  assert.equal(staff.me.userId, 'bar');
  assert.ok(!JSON.stringify(staff).includes('"srv"'), 'no one else’s numbers');
  assert.equal(f.as('sup')('leaderboard.get', {}).visible, false, 'supervisors are staff here');
  assert.equal(f.mgr('leaderboard.get', {}).rows.length, 2);
  f.admin('training.saveSettings', { leaderboard: 'all' });
  assert.equal(f.as('bar')('leaderboard.get', {}).rows.length, 2);
});

// ---------- manual ----------

test('manual: staff acknowledge pages; managers see who has and who hasn’t, and can ask for a re-read', () => {
  const f = fresh();
  const sec = f.mgr('manual.saveSection', { title: 'Policies', es: { title: 'Políticas' } });
  const page = f.mgr('manual.savePage', { sectionId: sec.id, title: 'Call-out procedure', body: '# Call\nCall the **manager on duty**.', isCallOut: true, es: { title: 'Avisos', body: '# Llama' } });
  assert.throws(() => f.as('srv')('manual.savePage', { sectionId: sec.id, title: 'x' }), /Managers only/);
  assert.throws(() => f.mgr('manual.deleteSection', { id: sec.id }), /Move or delete its 1 page first/);

  assert.equal(f.as('srv')('manual.get', { callOut: true }).id, page.id);
  assert.equal(f.as('srv')('manual.get', { callOut: true }).es.title, 'Avisos');
  assert.equal(f.as('srv')('manual.get', { id: page.id }).my.current, false);
  f.clock.now = new Date('2026-11-20T13:00:00');
  const acked = f.as('srv')('manual.ack', { id: page.id });
  assert.equal(acked.my.current, true);
  assert.equal(acked.my.ackedAt, new Date('2026-11-20T13:00:00').toISOString());
  assert.equal(acked.acks, undefined, 'staff don’t see who else read it');
  f.as('bar')('manual.ack', { id: page.id });

  const asMgr = f.mgr('manual.get', { id: page.id });
  assert.deepEqual(asMgr.acks.map((a) => a.userId), ['bar', 'srv']);
  assert.ok(asMgr.missing.some((m) => m.userId === 'cook'));
  assert.equal(asMgr.ackCount, 2);

  // An edit without asking keeps the acknowledgments; asking for a re-read clears them and notifies people.
  f.mgr('manual.savePage', { id: page.id, body: 'Call the manager on duty. Then text.' });
  assert.equal(f.as('srv')('manual.get', { id: page.id }).my.current, true);
  f.mgr('manual.requireReack', { id: page.id });
  const after = f.mgr('manual.get', { id: page.id });
  assert.equal(after.ackCount, 0);
  assert.ok(after.missing.find((m) => m.userId === 'srv').oldAt, 'shows when they last read it');
  assert.deepEqual(f.as('srv')('training.summary').pages.map((p) => p.id), [page.id]);
  assert.match(f.store.list('notifications', (n) => n.userId === 'srv').pop().text, /updated “Call-out procedure”/);
  assert.match(f.store.list('notifications', (n) => n.userId === 'esp').pop().text, /actualizada “Avisos”/);
  f.as('srv')('manual.ack', { id: page.id });
  assert.equal(f.as('srv')('manual.get', { id: page.id }).my.current, true);

  // savePage with reack does both at once; only one page is the call-out page.
  const other = f.mgr('manual.savePage', { sectionId: sec.id, title: 'New call-out', body: 'x', isCallOut: true });
  assert.equal(f.store.get('manualPages', page.id).isCallOut, false);
  f.as('srv')('manual.ack', { id: other.id });
  f.mgr('manual.savePage', { id: other.id, body: 'y', reack: true });
  assert.equal(f.as('srv')('manual.get', { id: other.id }).my.current, false);
  assert.deepEqual(f.as('srv')('manual.list').sections[0].pages.map((p) => [p.title, p.body]), [['Call-out procedure', undefined], ['New call-out', undefined]]);
});

test('manual formatting: headings, lists, bold, links and notes, with no HTML and only safe links', async () => {
  const { parseBlocks, parseInline, safeHref, plainText } = await import('../web/src/minimark.js');
  const blocks = parseBlocks('# Call out\nCall **as early as you can**, with *details*.\n\n- one\n- two\n1. first\n2. second\n> Be kind\n## Next');
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'list', 'list', 'note', 'h']);
  assert.deepEqual([blocks[0].level, blocks[2].items, blocks[3].ordered, blocks[5].level], [1, ['one', 'two'], true, 2]);
  // Nested marks (this used to loop forever: the parser recurses).
  assert.deepEqual(parseInline('a **b [c](https://x.test) d** *e*'), [
    { t: 'text', v: 'a ' },
    { t: 'b', c: [{ t: 'text', v: 'b ' }, { t: 'a', href: 'https://x.test', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' d' }] },
    { t: 'text', v: ' ' }, { t: 'i', c: [{ t: 'text', v: 'e' }] },
  ]);
  // Raw HTML stays text; unsafe links stay text.
  assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  const unsafe = parseInline('[x](javascript:alert(1))');
  assert.ok(unsafe.every((x) => x.t === 'text'));
  assert.equal(unsafe.map((x) => x.v).join(''), '[x](javascript:alert(1))');
  for (const ok of ['https://a.test/b?c=1', 'mailto:a@b.test', 'tel:+1 555 010 0100', 'sms:5550100100', '#/training/manual']) assert.equal(safeHref(ok), ok);
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '//evil.test', 'vbscript:x']) assert.equal(safeHref(bad), null);
  assert.equal(plainText('# Hi\n**Bold** and [link](https://x.test)'), 'Hi Bold and link');
});

// ---------- manager on duty ----------

function modFixture() {
  const f = fresh();
  const shift = (userId, jobCodeId, date, start, end, published = true) => f.store.insert('shifts', { date, start, end, jobCodeId, userId, area: '', tag: '', notes: '', breakMin: 0, published });
  shift('mgrA', 'job_mgr', '2026-11-20', '10:00', '16:00');
  shift('mgrB', 'job_mgr', '2026-11-20', '16:00', null); // until close (est. 23:00 on a Friday: 7 hr cap)
  shift('chef', 'job_chef', '2026-11-20', '11:00', '22:00');
  shift('admin', 'job_mgr', '2026-11-20', '06:00', '09:00', false); // a draft doesn't count
  shift('srv', 'job_srv', '2026-11-20', '11:00', '20:00');
  return f;
}

test('manager on duty: who’s on now (front of house first, newest in charge), who’s next, an override, or the call-out line', () => {
  const f = modFixture();
  const mod = (h, m = 0) => { f.clock.now = new Date(2026, 10, 20, h, m); return f.as('srv')('mod.get'); };
  let r = mod(12);
  assert.deepEqual([r.status, r.person.id, r.person.shift.start, r.alsoOn.map((x) => x.id)], ['now', 'mgrA', '10:00', ['chef']], 'the chef is on, but the FOH manager is in charge');
  r = mod(17);
  assert.deepEqual([r.status, r.person.id, r.person.shift.estimatedEnd], ['now', 'mgrB', true]);
  r = mod(8);
  assert.deepEqual([r.status, r.person.id], ['next', 'mgrA'], 'no one yet: the next manager due in today');
  r = mod(23, 30);
  assert.deepEqual([r.status, r.person, r.callOutPhone], ['none', null, '']);
  f.admin('training.saveSettings', { callOutPhone: '(555) 010-0000' });
  assert.equal(mod(23, 30).callOutPhone, '(555) 010-0000');
  assert.throws(() => f.admin('training.saveSettings', { callOutPhone: 'call me' }), /phone number/);

  // A shift from last night that runs past midnight.
  f.store.insert('shifts', { date: '2026-11-19', start: '20:00', end: '02:00', jobCodeId: 'job_mgr', userId: 'admin', published: true });
  r = mod(1);
  assert.deepEqual([r.status, r.person.id], ['now', 'admin']);

  // An override for the day wins; managers only, and only a manager or supervisor can be picked.
  assert.throws(() => f.as('srv')('mod.setOverride', { date: '2026-11-20', userId: 'sup' }), /Managers only/);
  assert.throws(() => f.mgr('mod.setOverride', { date: '2026-11-20', userId: 'srv' }), /manager or supervisor/);
  f.clock.now = new Date(2026, 10, 20, 12);
  const set = f.mgr('mod.setOverride', { date: '2026-11-20', userId: 'sup' });
  assert.deepEqual([set.status, set.person.id, set.override], ['override', 'sup', 'sup']);
  assert.deepEqual(set.scheduled.map((x) => x.id), ['mgrA', 'chef', 'mgrB']);
  r = mod(12);
  assert.deepEqual([r.status, r.person.id, r.person.phone], ['override', 'sup', '(555) 010-4444']);
  f.mgr('mod.setOverride', { date: '2026-11-20', userId: null });
  assert.equal(mod(12).person.id, 'mgrA');
});

test('manager on duty: staff get only the on-duty manager’s phone (and the call-out line), nobody else’s', () => {
  const f = modFixture();
  f.clock.now = new Date(2026, 10, 20, 12);
  const r = f.as('srv')('mod.get', { date: '2026-11-21' });
  assert.equal(r.date, '2026-11-20', 'staff only see today');
  assert.equal(r.person.phone, '(555) 010-1111');
  const json = JSON.stringify(r);
  for (const other of ['(555) 010-2222', '(555) 010-3333', '(555) 010-4444', '(555) 010-5555', '(555) 010-6666', '(555) 010-7777']) assert.ok(!json.includes(other), other);
  assert.equal(r.candidates, undefined);
  assert.equal(r.scheduled, undefined);
  // The usual rule still holds everywhere else: employees don't see coworkers' phones.
  const boot = f.as('srv')('app.bootstrap');
  assert.ok(boot.employees.filter((e) => e.id !== 'srv').every((e) => e.phone === undefined));
});

// ---------- the demo ----------

test('the demo comes with a menu, quizzes with tries, the manual with a call-out page, and a manager on duty', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T12:00:00') });
  const u = (n) => store.get('users', ids.userId[n]);
  const menu = svc.call(u('Alex D'), 'menu.list');
  assert.ok(menu.items.length >= 8 && menu.items.length <= 12);
  assert.deepEqual(menu.categories, ['Starters', 'Mains', 'Desserts', 'Cocktails', 'Wine']);
  assert.ok(menu.items.every((i) => i.recipe === undefined), 'a server sees no recipes');
  assert.ok(svc.call(u('Mak'), 'menu.list').items.find((i) => i.name === 'Copper Fox Mule').recipe.ingredients.length, 'a bartender does');
  assert.ok(svc.call(u('Agustina'), 'menu.list').items.find((i) => i.name === 'Garden Spritz').recipe, 'the Spritz recipe is shared with the Moon Rabbit');
  assert.ok(svc.call(u('Moe'), 'leaderboard.get', {}).rows.length >= 8);
  assert.equal(svc.call(u('Alex D'), 'manual.get', { callOut: true }).title, 'Call-out procedure');
  const mod = svc.call(u('Alex D'), 'mod.get');
  assert.deepEqual([mod.status, mod.person.name, mod.callOutPhone], ['override', 'Kelly', '(555) 010-0100']);
});

// ---------- HTTP: photos need sign-in ----------

test('HTTP: photos are uploaded one per request and served only to signed-in people', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  const rpc = async (cookie, method, args) => {
    const res = await fetch(`${base}/api/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(args) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const moe = await login('moe@demo.shiftboard');
    const alex = await login('alexd@demo.shiftboard');
    const up = await rpc(moe, 'menu.addPhoto', { itemId: 'mnu_burger', dataUrl: tinyJpeg(300 * 1024), w: 1200, h: 900 });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const id = up.body.result.photo.id;
    assert.equal((await rpc(alex, 'menu.addPhoto', { itemId: 'mnu_burger', dataUrl: tinyJpeg() })).status, 403);
    const tooBig = await rpc(moe, 'menu.addPhoto', { itemId: 'mnu_burger', dataUrl: tinyJpeg(PHOTO_MAX_BYTES + 10) });
    assert.equal(tooBig.status, 413);

    assert.equal((await fetch(`${base}/api/training/photos/${id}`)).status, 401, 'signed out: no photo');
    const img = await fetch(`${base}/api/training/photos/${id}`, { headers: { Cookie: alex } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control'), /^private, .*immutable/);
    assert.equal((await img.arrayBuffer()).byteLength, 300 * 1024);
    assert.equal((await fetch(`${base}/api/training/photos/nope`, { headers: { Cookie: alex } })).status, 404);
    const seeded = await fetch(`${base}/api/training/photos/mph_burger_1`, { headers: { Cookie: alex } });
    assert.equal(seeded.headers.get('content-type'), 'image/svg+xml');
    assert.equal(seeded.headers.get('content-security-policy'), "default-src 'none'");

    // A quiz attempt over HTTP carries no answers; its photos come by attempt + question.
    const photoQuiz = await rpc(moe, 'quiz.save', { title: 'Photos', types: ['photo', 'allergen'], count: 6 });
    const att = await rpc(alex, 'quiz.start', { quizId: photoQuiz.body.result.id });
    assert.equal(att.status, 200);
    assert.ok(!JSON.stringify(att.body).includes('correctId'));
    assert.ok(!JSON.stringify(att.body).includes('mph_'), 'no photo ids that point at an item');
    const photoQ = att.body.result.questions.find((q) => q.photo);
    assert.ok(photoQ, 'the seeded items have photos');
    const quizPhoto = `${base}/api/training/quiz-photo/${att.body.result.id}/${photoQ.key}`;
    assert.equal((await fetch(quizPhoto)).status, 401);
    assert.equal((await fetch(quizPhoto, { headers: { Cookie: alex } })).status, 200);
    assert.equal((await fetch(quizPhoto, { headers: { Cookie: await login('styves@demo.shiftboard') } })).status, 404, 'someone else’s attempt');
    const done = await rpc(alex, 'quiz.submit', { attemptId: att.body.result.id, answers: {} });
    assert.equal(done.body.result.score, 0);
    assert.ok(done.body.result.questions.every((q) => q.correctId));

    // Photo bytes stay in Postgres: this instance's cache and a cold-started one hold none, and both serve them.
    assert.equal(db.store.get('menuPhotos', id).data, undefined);
    const cold = new DocDb(conn);
    await cold.sync();
    assert.equal(cold.store.get('menuPhotos', id).data, undefined, 'a cold start loads no photo bytes');
    assert.equal(cold.store.get('menuPhotos', id).mime, 'image/jpeg');
    assert.equal((await cold.lazyData('menuPhotos', id)).length, Math.ceil(300 * 1024 / 3) * 4, 'the bytes are still in Postgres');
    // Saving the cached copy (no bytes) again keeps the stored bytes.
    await db.run((store) => store.update('menuPhotos', id, { note: 'touched' }), { write: true });
    const again = await fetch(`${base}/api/training/photos/${id}`, { headers: { Cookie: alex } });
    assert.equal((await again.arrayBuffer()).byteLength, 300 * 1024);

    // Staff get the manager on duty's phone through mod.get and nobody else's through bootstrap.
    const boot = await rpc(alex, 'app.bootstrap', {});
    assert.ok(boot.body.result.employees.filter((e) => e.name !== 'Alex D').every((e) => !e.phone));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
