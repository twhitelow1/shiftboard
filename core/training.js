// Training: the menu study guide, quizzes, the leaderboard, the employee manual and the manager on duty.
// core/service.js spreads these methods into its API; each one checks its own permissions like the rest.
//
// Collections
//   menuItems       one per dish or drink; photo metadata lives on the item (photos: [{ id, w, h, bytes }])
//   menuPhotos      one photo per document (base64), served behind sign-in by server/training-routes.js
//   quizzes         a set of menu sections and/or items, question types, count, passing score, assignment
//   quizQuestions   managers' own questions (multiple choice or true/false), optionally tied to an item
//   quizAttempts    one per try; holds the questions with their answers, which never reach the client
//                   before the question (or, at the end, the quiz) is answered
//   manualSections, manualPages, manualAcks ('<pageId>:<userId>')
//   modOverrides    the manager on duty chosen by hand for a day (id = the date)
//   trainingConfig  'main': leaderboard visibility, call-out line, who sees recipes by default, section order
//
// Who sees what on a menu item
//   basics (name, section, description, price, photos, key ingredients, allergens, dietary tags, 86'd): everyone
//   selling (how to describe it, pairings): everyone unless limited
//   recipe (ingredients with amounts, steps) and prep notes: kitchen and bar departments by default
//   Managers and up see everything. Each item can change the rule for each group.
//
// Languages: managers can add a Spanish version (`es`) of what they write: an item's name, description, key
// ingredients, selling notes, recipe and prep notes; their own quiz questions; quiz titles; manual pages and
// sections. People whose language is Spanish (user.language === 'es') see it where it exists, English otherwise.
// Words the app writes itself (generated quiz questions, allergen names, notifications) are in TEXT below.
import { uid } from './store.js';
import { atLeast, canManageSchedule, canChangeSettings, canSeeContacts } from './roles.js';
import { isManagerJob, isModShift } from './mod.js';
import { addDays, todayStr, daysBetween, shiftSpan, parseDate, MONTHS, DOW_SHORT } from './time.js';
import { effectiveShift } from './forecast.js';

export const LANGS = ['en', 'es'];
/** A person's language: their own choice, else the restaurant's default (settings.language), else English. */
export const langOf = (u, settings) => (u?.language === 'es' || u?.language === 'en' ? u.language : settings?.language === 'es' ? 'es' : 'en');

export const MAJOR_ALLERGENS = [
  { id: 'milk', label: 'Milk', es: 'Leche' }, { id: 'eggs', label: 'Eggs', es: 'Huevo' }, { id: 'fish', label: 'Fish', es: 'Pescado' },
  { id: 'shellfish', label: 'Shellfish', es: 'Mariscos' }, { id: 'tree nuts', label: 'Tree nuts', es: 'Nueces de árbol' },
  { id: 'peanuts', label: 'Peanuts', es: 'Cacahuate (maní)' }, { id: 'wheat', label: 'Wheat', es: 'Trigo' },
  { id: 'soy', label: 'Soy', es: 'Soya' }, { id: 'sesame', label: 'Sesame', es: 'Ajonjolí' },
];
const ALLERGEN_WORDS = {
  dairy: 'milk', egg: 'eggs', 'tree nut': 'tree nuts', treenuts: 'tree nuts', nuts: 'tree nuts', peanut: 'peanuts', 'crustacean shellfish': 'shellfish',
  crustaceans: 'shellfish', soybeans: 'soy', soya: 'soy', leche: 'milk', lacteos: 'milk', huevo: 'eggs', huevos: 'eggs', pescado: 'fish', mariscos: 'shellfish',
  nueces: 'tree nuts', 'nueces de arbol': 'tree nuts', cacahuate: 'peanuts', cacahuates: 'peanuts', mani: 'peanuts', trigo: 'wheat', ajonjoli: 'sesame', sesamo: 'sesame',
};
// Standard dietary tags (stored in English; the app shows them in the viewer's language).
export const DIETARY_TAGS = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'spicy'];
export const DEFAULT_CATEGORIES = ['Starters', 'Mains', 'Sides', 'Desserts', 'Cocktails', 'Beer', 'Wine', 'Non-alcoholic'];
export const QUESTION_TYPES = ['photo', 'allergen', 'ingredient', 'category', 'custom'];
export const FIELD_GROUPS = ['selling', 'recipe', 'prep'];
export const PHOTO_MAX_BYTES = 500 * 1024; // after the browser resizes it (about 1200px JPEG/WebP)
export const PHOTOS_PER_ITEM = 8;
export const MASTERY = { answers: 2, pct: 80 }; // an item is mastered after 2+ answers about it, 80%+ right

/** Everything Training writes itself, in each language: generated quiz questions, menu words, notifications. */
export const TEXT = {
  en: {
    qPhoto: 'Which menu item is this?',
    qAllergen: (n) => `Which allergen is in ${n}?`,
    qNoAllergen: (n) => `True or false: ${n} has none of the 9 major allergens.`,
    qIngredient: (n) => `Which of these is in ${n}?`,
    qCategory: (n) => `Which part of the menu is ${n} on?`,
    true: 'True', false: 'False',
    dietary: { vegetarian: 'Vegetarian', vegan: 'Vegan', 'gluten-free': 'Gluten-free', 'dairy-free': 'Dairy-free', spicy: 'Spicy' },
    categories: {},
    nNewQuiz: (title, due) => `New quiz for you: ${title}${due ? `, due ${due}` : ''}.`,
    nQuizDue: (title, due) => `${title} is now due ${due}.`,
    nReread: (title) => `Please read the updated “${title}” page in the employee manual and tap “I’ve read this”.`,
  },
  es: {
    qPhoto: '¿Qué platillo o bebida del menú es?',
    qAllergen: (n) => `¿Qué alérgeno contiene ${n}?`,
    qNoAllergen: (n) => `Verdadero o falso: ${n} no tiene ninguno de los 9 alérgenos principales.`,
    qIngredient: (n) => `¿Cuál de estos lleva ${n}?`,
    qCategory: (n) => `¿En qué parte del menú está ${n}?`,
    true: 'Verdadero', false: 'Falso',
    dietary: { vegetarian: 'Vegetariano', vegan: 'Vegano', 'gluten-free': 'Sin gluten', 'dairy-free': 'Sin lácteos', spicy: 'Picante' },
    categories: { starters: 'Entradas', appetizers: 'Entradas', mains: 'Platos fuertes', entrees: 'Platos fuertes', sides: 'Guarniciones', desserts: 'Postres', cocktails: 'Cocteles', beer: 'Cerveza', wine: 'Vino', nonalcoholic: 'Sin alcohol', other: 'Otros', drinks: 'Bebidas', salads: 'Ensaladas', soups: 'Sopas' },
    nNewQuiz: (title, due) => `Tienes un nuevo cuestionario: ${title}${due ? `, para el ${due}` : ''}.`,
    nQuizDue: (title, due) => `${title} ahora vence el ${due}.`,
    nReread: (title) => `Lee la página actualizada “${title}” del manual del empleado y toca “Ya lo leí”.`,
  },
};
const DOW_ES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** 'Fri, Oct 9' / 'vie 9 oct' */
export function dayLabel(date, lang = 'en') {
  const d = parseDate(date);
  return lang === 'es' ? `${DOW_ES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()]}` : `${DOW_SHORT[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
}

const PHOTO_TYPES = { 'image/jpeg': [[0xff, 0xd8, 0xff]], 'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], 'image/webp': [[0x52, 0x49, 0x46, 0x46]] };
// Departments whose people prepare food and drinks: they get recipes and prep notes by default.
const BACK_OF_HOUSE = /kitchen|culinary|\bcooks?\b|\bchefs?\b|\bprep\b|pastry|\bbars?\b|bartend|back of house|\bboh\b/i;
// A manager-level job in the kitchen (Chef, Sous Chef): on duty only when no front-of-house manager is.
const KITCHEN_JOB = /chef|kitchen|cook|culinary|pastry|\bsous\b/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const para = (v, max) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
const key = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const same = (a, b) => !!key(a) && key(a) === key(b);
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/));
const uniq = (arr) => arr.filter((x, i) => x && arr.findIndex((y) => same(x, y)) === i);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const has = (s) => typeof s === 'string' && s.trim() !== '';
const MAJOR_BY_ID = Object.fromEntries(MAJOR_ALLERGENS.map((a) => [a.id, a]));

export const allergenLabel = (a, lang = 'en') => { const m = MAJOR_BY_ID[a]; return m ? (lang === 'es' ? m.es : m.label) : cap(a); };
export const dietaryLabel = (tag, lang = 'en') => TEXT[lang].dietary[tag] || TEXT.en.dietary[tag] || cap(tag);
/** A menu section's name in a language: the restaurant's own Spanish name, a built-in one, or as written. */
export const categoryLabel = (c, lang = 'en', own = {}) => {
  if (lang !== 'es' || !c) return c;
  const mine = Object.entries(own || {}).find(([k]) => same(k, c));
  return (mine && has(mine[1]) ? mine[1] : TEXT.es.categories[key(c)]) || c;
};

/** 'Tree Nuts', 'dairy', 'cacahuate' → the major allergen's id; anything else is a custom allergen in lower case. */
export function canonicalAllergen(v) {
  const t = text(v, 30).toLowerCase();
  if (!t) return '';
  const hit = MAJOR_ALLERGENS.find((a) => same(a.id, t) || same(a.label, t) || same(a.es, t));
  if (hit) return hit.id;
  const word = Object.entries(ALLERGEN_WORDS).find(([w]) => same(w, t));
  return word ? word[1] : t;
}

/**
 * An item as its viewer should read it: the Spanish version of each field where there is one, English
 * otherwise. Works on what menu.list / menu.get return (only the groups the viewer may see) and on raw items.
 */
export function localizeItem(item, lang) {
  const es = item?.es;
  if (lang !== 'es' || !es) return item;
  const pickRows = (e, b) => (Array.isArray(e) && e.length ? e : b);
  return {
    ...item,
    name: has(es.name) ? es.name : item.name,
    description: has(es.description) ? es.description : item.description,
    keyIngredients: pickRows(es.keyIngredients, item.keyIngredients),
    ...(item.selling ? { selling: { notes: has(es.selling?.notes) ? es.selling.notes : item.selling.notes, pairings: has(es.selling?.pairings) ? es.selling.pairings : item.selling.pairings } } : {}),
    ...(item.recipe ? { recipe: { yield: has(es.recipe?.yield) ? es.recipe.yield : item.recipe.yield, ingredients: pickRows(es.recipe?.ingredients, item.recipe.ingredients), steps: pickRows(es.recipe?.steps, item.recipe.steps) } } : {}),
    ...(item.prep ? { prep: { notes: has(es.prep?.notes) ? es.prep.notes : item.prep.notes } } : {}),
  };
}
/** A manual page or section, quiz or custom question in the viewer's language (title/body/text/description/explain). */
export function localize(doc, lang) {
  const es = doc?.es;
  if (lang !== 'es' || !es) return doc;
  const out = { ...doc };
  for (const k of ['title', 'body', 'text', 'description', 'explain']) if (has(es[k])) out[k] = es[k];
  if (Array.isArray(doc.choices) && Array.isArray(es.choices)) out.choices = doc.choices.map((c, i) => (has(es.choices[i]) ? es.choices[i] : c));
  return out;
}

/** Decoded size of a base64 string. */
const b64Bytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** Check an uploaded photo: a JPEG, PNG or WebP data URL whose bytes really are that kind of image, under the size limit. */
export function checkPhoto(dataUrl, fail) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) fail(400, 'Upload a JPG, PNG or WebP photo');
  const [, mime, data] = m;
  const bytes = b64Bytes(data);
  if (bytes > PHOTO_MAX_BYTES) fail(413, `That photo is too large (${Math.round(bytes / 1024)} KB). Photos can be up to ${Math.round(PHOTO_MAX_BYTES / 1024)} KB.`);
  if (bytes < 32) fail(400, 'That photo is empty');
  const head = Array.from(globalThis.atob(data.slice(0, 16)), (c) => c.charCodeAt(0)); // the first 12 bytes
  const sigOk = PHOTO_TYPES[mime].some((sig) => sig.every((b, i) => head[i] === b))
    && (mime !== 'image/webp' || String.fromCharCode(...head.slice(8, 12)) === 'WEBP');
  if (!sigOk) fail(400, 'That file isn’t the kind of image it says it is');
  return { mime, data, bytes };
}

export function trainingApi({ store, now, settings, notify, fail, random = Math.random, langOf: userLang = (u) => langOf(u, settings()) }) {
  const today = () => todayStr(now());
  const isMgr = (a) => canManageSchedule(a);
  const needAuth = (a) => { if (!a) fail(401, 'Please sign in'); };
  const needMgr = (a) => { needAuth(a); if (!isMgr(a)) fail(403, 'Managers only'); };
  const needAdmin = (a) => { needAuth(a); if (!canChangeSettings(a)) fail(403, 'Admins only'); };
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const jobMap = () => Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j]));
  const activeUsers = () => store.list('users', (u) => u.active !== false);
  const nameOf = (id) => store.get('users', id)?.name || '';
  const jobIdsOf = (u) => (u?.jobCodes || []).map((j) => j.jobCodeId);
  const pct = (n, d) => (d ? Math.round((n * 100) / d) : 0);
  /** Notify people, each in their own language: make(T, lang) builds the text. */
  const notifyEach = (users, make, link) => {
    if (users.length) notify(users.map((u) => u.id), (lang) => make(TEXT[lang] || TEXT.en, lang), link);
  };

  // ---------- settings ----------
  function knownDepartments() {
    return uniq([...(settings().departments || []), ...store.list('jobCodes').filter((j) => !j.archived).map((j) => j.department)].map((d) => text(d, 60)));
  }
  function cleanRule(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.all) return { all: true };
    const jobs = jobMap();
    return {
      departments: uniq(list(r.departments).map((d) => text(d, 60))).slice(0, 30),
      jobCodeIds: [...new Set(list(r.jobCodeIds).filter((id) => jobs[id]))],
    };
  }
  function config() {
    const c = store.get('trainingConfig', 'main') || {};
    const boh = knownDepartments().filter((d) => BACK_OF_HOUSE.test(d));
    const bohRule = { departments: boh, jobCodeIds: [] };
    return {
      leaderboard: c.leaderboard === 'managers' ? 'managers' : 'all',
      callOutPhone: c.callOutPhone || '',
      categoryOrder: Array.isArray(c.categoryOrder) && c.categoryOrder.length ? c.categoryOrder : DEFAULT_CATEGORIES,
      categoryEs: c.categoryEs && typeof c.categoryEs === 'object' ? c.categoryEs : {},
      defaults: {
        selling: cleanRule(c.defaults?.selling) || { all: true },
        recipe: cleanRule(c.defaults?.recipe) || bohRule,
        prep: cleanRule(c.defaults?.prep) || bohRule,
      },
    };
  }
  function cleanPhone(v) {
    const t = text(v, 30);
    if (!t) return '';
    const digits = t.replace(/\D/g, '');
    if (!/^[+()\-.\s\d]+$/.test(t) || digits.length < 7 || digits.length > 15) fail(400, 'That phone number doesn’t look right');
    return t;
  }

  // ---------- who sees what ----------
  function ruleMatches(actor, rule) {
    if (!rule || rule.all) return true;
    const mine = jobIdsOf(actor);
    if ((rule.jobCodeIds || []).some((id) => mine.includes(id))) return true;
    const jobs = jobMap();
    const depts = mine.map((id) => jobs[id]?.department).filter(Boolean);
    return (rule.departments || []).some((d) => depts.some((x) => same(x, d)));
  }
  /** Whether the actor may see a field group ('selling', 'recipe', 'prep') of an item (or the default rule when item is null). */
  function canSee(actor, item, group, cfg = config()) {
    if (isMgr(actor)) return true;
    const own = item?.visibility?.[group];
    return ruleMatches(actor, own ? cleanRule(own) : cfg.defaults[group]);
  }
  const emptyRecipe = () => ({ yield: '', ingredients: [], steps: [] });
  function itemView(actor, it, cfg) {
    const can = Object.fromEntries(FIELD_GROUPS.map((g) => [g, canSee(actor, it, g, cfg)]));
    const es = it.es || {};
    const out = {
      id: it.id, name: it.name, category: it.category, description: it.description || '', price: it.price ?? null,
      keyIngredients: it.keyIngredients || [], allergens: it.allergens || [], dietary: it.dietary || [],
      eightySixed: !!it.eightySixed, photos: (it.photos || []).map(({ id, w, h }) => ({ id, w, h })), order: it.order ?? 0,
      updatedAt: it.updatedAt || it.createdAt || '', can,
      // The Spanish version, holding only the groups this viewer may see (like the English fields below).
      es: {
        name: es.name || '', description: es.description || '', keyIngredients: es.keyIngredients || [],
        ...(can.selling ? { selling: { notes: '', pairings: '', ...(es.selling || {}) } } : {}),
        ...(can.recipe ? { recipe: { ...emptyRecipe(), ...(es.recipe || {}) } } : {}),
        ...(can.prep ? { prep: { notes: '', ...(es.prep || {}) } } : {}),
      },
    };
    if (can.selling) out.selling = { notes: '', pairings: '', ...(it.selling || {}) };
    if (can.recipe) out.recipe = { ...emptyRecipe(), ...(it.recipe || {}) };
    if (can.prep) out.prep = { notes: '', ...(it.prep || {}) };
    if (isMgr(actor)) out.visibility = it.visibility || {};
    return out;
  }
  function categoriesOf(items, cfg = config()) {
    const cats = uniq(items.map((i) => i.category));
    const rank = (c) => { const i = cfg.categoryOrder.findIndex((x) => same(x, c)); return i < 0 ? 1000 : i; };
    const firstOrder = (c) => Math.min(...items.filter((i) => same(i.category, c)).map((i) => i.order ?? 0));
    return cats.sort((a, b) => rank(a) - rank(b) || firstOrder(a) - firstOrder(b));
  }
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name));

  const cleanIngredients = (rows) => (Array.isArray(rows) ? rows : [])
    .map((r) => ({ qty: text(r?.qty, 30), item: text(r?.item, 80) })).filter((r) => r.item).slice(0, 60);
  const cleanSteps = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((s) => text(s, 600)).filter(Boolean).slice(0, 40);
  const cleanWords = (v, max) => uniq(list(v).map((x) => text(x, max)));
  function cleanEs(e) {
    const r = e?.recipe || {};
    return {
      name: text(e?.name, 80),
      description: para(e?.description, 1500),
      keyIngredients: cleanWords(e?.keyIngredients, 60).slice(0, 30),
      selling: { notes: para(e?.selling?.notes, 3000), pairings: para(e?.selling?.pairings, 1000) },
      recipe: { yield: text(r.yield, 80), ingredients: cleanIngredients(r.ingredients), steps: cleanSteps(r.steps) },
      prep: { notes: para(e?.prep?.notes, 3000) },
    };
  }
  function cleanItem(a, cur) {
    const name = text(a.name ?? cur?.name, 80);
    if (!name) fail(400, 'Name is required');
    const price = a.price === '' || a.price == null ? null : Number(String(a.price).replace(/[$,\s]/g, ''));
    if (price != null && (!Number.isFinite(price) || price < 0 || price > 100000)) fail(400, 'Price must be a number');
    const recipe = a.recipe || {};
    const visibility = {};
    for (const g of FIELD_GROUPS) {
      const r = a.visibility?.[g];
      if (r) visibility[g] = cleanRule(r);
    }
    return {
      name,
      category: text(a.category, 40) || 'Other',
      description: para(a.description, 1500),
      price: price == null ? null : Math.round(price * 100) / 100,
      keyIngredients: cleanWords(a.keyIngredients, 60).slice(0, 30),
      allergens: uniq(list(a.allergens).map(canonicalAllergen)).slice(0, 20),
      dietary: uniq(list(a.dietary).map((x) => text(x, 30).toLowerCase())).slice(0, 15),
      eightySixed: !!a.eightySixed,
      selling: { notes: para(a.selling?.notes, 3000), pairings: para(a.selling?.pairings, 1000) },
      recipe: { yield: text(recipe.yield, 80), ingredients: cleanIngredients(recipe.ingredients), steps: cleanSteps(recipe.steps) },
      prep: { notes: para(a.prep?.notes, 3000) },
      es: cleanEs(a.es ?? cur?.es),
      visibility,
    };
  }

  // ---------- quizzes ----------
  const quizById = (id) => store.get('quizzes', id);
  const assignedTo = (quiz, u) => !!quiz.jobCodeIds?.length && jobIdsOf(u).some((id) => quiz.jobCodeIds.includes(id));
  const assignedUsers = (quiz) => activeUsers().filter((u) => assignedTo(quiz, u));
  const submitted = (filter = () => true) => store.list('quizAttempts', (t) => !!t.submittedAt && filter(t));

  function inScope(quiz, items) {
    const cats = quiz.categories || [], ids = quiz.itemIds || [];
    if (!cats.length && !ids.length) return items;
    return items.filter((i) => ids.includes(i.id) || cats.some((c) => same(c, i.category)));
  }
  /** Ingredient names the taker can know about: the key ingredients, plus the recipe's if they may see recipes. */
  function visibleIngredients(actor, item, cfg, lang) {
    const out = [];
    const add = (s) => { const t = text(s, 60); if (t && !out.some((x) => same(x, t))) out.push(t); };
    const loc = localizeItem({ ...item, recipe: item.recipe || emptyRecipe() }, lang);
    (loc.keyIngredients || []).forEach(add);
    // Recipe ingredients only for people who may see the recipe: a quiz must not leak it.
    if (canSee(actor, item, 'recipe', cfg)) (loc.recipe?.ingredients || []).forEach((r) => add(r.item));
    return out;
  }
  function customInScope(actor, quiz, scope, cfg) {
    const ids = new Set(scope.map((i) => i.id));
    const picked = new Set(quiz.questionIds || []);
    const cats = quiz.categories || [];
    const whole = !cats.length && !(quiz.itemIds || []).length;
    return store.list('quizQuestions').filter((q) => {
      const inIt = picked.has(q.id) || (q.itemId && ids.has(q.itemId)) || (!q.itemId && q.category && (whole || cats.some((c) => same(c, q.category))));
      if (!inIt) return false;
      if (q.audience === 'recipe') return canSee(actor, q.itemId ? store.get('menuItems', q.itemId) : null, 'recipe', cfg);
      return true;
    });
  }

  /**
   * Questions for one try at a quiz, made from the menu as the taker can see it and in the taker's language.
   * Each has its choices in a random order with neutral ids (a, b, c…); which one is right stays on the server.
   */
  function generate(actor, quiz) {
    const lang = userLang(actor);
    const T = TEXT[lang];
    const cfg = config();
    const menu = store.list('menuItems').sort(byOrder);
    const scope = inScope(quiz, menu.filter((i) => !i.eightySixed));
    const types = new Set(quiz.types?.length ? quiz.types : QUESTION_TYPES);
    const nameIn = (it) => (lang === 'es' && has(it.es?.name) ? it.es.name : it.name);
    const catIn = (c) => categoryLabel(c, lang, cfg.categoryEs);
    const cats = categoriesOf(menu, cfg);
    const ingredients = new Map(menu.map((i) => [i.id, visibleIngredients(actor, i, cfg, lang)]));
    const allergenPool = uniq([...MAJOR_ALLERGENS.map((a) => a.id), ...menu.flatMap((i) => i.allergens || [])]);
    const groups = new Map();
    const add = (k, q) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(q); };

    for (const it of scope) {
      const name = nameIn(it);
      const base = { itemId: it.id, itemName: name, category: it.category };
      if (types.has('photo') && it.photos?.length) {
        const others = shuffle(menu.filter((o) => o.id !== it.id && !same(nameIn(o), name)));
        const wrong = [...others.filter((o) => same(o.category, it.category)), ...others.filter((o) => !same(o.category, it.category))].slice(0, 3);
        if (wrong.length) add(it.id, { ...base, type: 'photo', prompt: T.qPhoto, photoId: pick(it.photos).id, choices: [name, ...wrong.map(nameIn)] });
      }
      if (types.has('allergen')) {
        const mine = it.allergens || [];
        if (mine.length) {
          const wrong = shuffle(allergenPool.filter((a) => !mine.some((h) => same(h, a)))).slice(0, 3);
          if (wrong.length) add(it.id, { ...base, type: 'allergen', prompt: T.qAllergen(name), choices: [pick(mine), ...wrong].map((a) => allergenLabel(a, lang)) });
        } else {
          add(it.id, { ...base, type: 'allergen', prompt: T.qNoAllergen(name), choices: [T.true, T.false], fixed: true });
        }
      }
      if (types.has('ingredient')) {
        const mine = ingredients.get(it.id);
        if (mine.length) {
          const pool = uniq(menu.filter((o) => o.id !== it.id).flatMap((o) => ingredients.get(o.id))).filter((x) => !mine.some((m) => same(m, x)));
          const wrong = shuffle(pool).slice(0, 3);
          if (wrong.length) add(it.id, { ...base, type: 'ingredient', prompt: T.qIngredient(name), choices: [pick(mine), ...wrong] });
        }
      }
      if (types.has('category') && it.category) {
        const wrong = shuffle(cats.filter((c) => !same(c, it.category))).slice(0, 3);
        if (wrong.length) add(it.id, { ...base, type: 'category', prompt: T.qCategory(name), choices: [it.category, ...wrong].map(catIn) });
      }
    }
    if (types.has('custom')) {
      for (const raw of customInScope(actor, quiz, scope, cfg)) {
        const q = localize(raw, lang);
        const item = q.itemId ? store.get('menuItems', q.itemId) : null;
        const tf = q.kind === 'tf';
        add(q.itemId || `custom:${q.id}`, {
          type: 'custom', questionId: q.id, itemId: item?.id || null, itemName: item ? nameIn(item) : '', category: item?.category || q.category || '',
          prompt: q.text, explain: q.explain || '',
          // A manager's own question keeps their order (True/False, "All of the above"…).
          keep: tf ? [T.true, T.false] : q.choices, keepCorrect: tf ? (q.correct ? 0 : 1) : q.correct,
        });
      }
    }

    // Round-robin over items so one quiz covers as many dishes as it can.
    const lanes = shuffle([...groups.values()].map(shuffle));
    const out = [];
    const want = Math.max(1, Number(quiz.count) || 10);
    for (let round = 0; out.length < want; round++) {
      let took = false;
      for (const lane of lanes) if (lane[round] && out.length < want) { out.push(lane[round]); took = true; }
      if (!took) break;
    }
    const ids = 'abcdef';
    return shuffle(out).map((q, i) => {
      let choices, correctId;
      if (q.keep) {
        choices = q.keep.map((t, k) => ({ id: ids[k], text: t }));
        correctId = ids[q.keepCorrect];
      } else { // the right answer is choices[0] until here
        const order = q.fixed ? q.choices.map((_, k) => k) : shuffle(q.choices.map((_, k) => k));
        choices = order.map((k, pos) => ({ id: ids[pos], text: q.choices[k] }));
        correctId = ids[order.indexOf(0)];
      }
      return {
        key: `q${i + 1}`, type: q.type, prompt: q.prompt, choices, correctId, answerId: null,
        itemId: q.itemId || null, itemName: q.itemName || '', category: q.category || '',
        ...(q.photoId ? { photoId: q.photoId } : {}), ...(q.questionId ? { questionId: q.questionId } : {}), ...(q.explain ? { explain: q.explain } : {}),
      };
    });
  }

  /** What the taker sees. Before the quiz is handed in, a question shows its answer only once it's locked in ("each" mode). */
  function attemptView(att) {
    const done = !!att.submittedAt;
    return {
      id: att.id, quizId: att.quizId, title: att.title, feedback: att.feedback, passingScore: att.passingScore ?? null, lang: att.lang || 'en',
      userId: att.userId, startedAt: att.startedAt, submittedAt: att.submittedAt || null, total: att.questions.length,
      ...(done ? { score: att.score, pct: att.pct, passed: att.passed } : {}),
      questions: att.questions.map((q) => {
        const reveal = done || (att.feedback === 'each' && !!q.answerId);
        return {
          key: q.key, type: q.type, prompt: q.prompt, photo: !!q.photoId, choices: q.choices, answerId: q.answerId || null,
          ...(reveal ? { correctId: q.correctId, correct: !!q.answerId && q.answerId === q.correctId, explain: q.explain || '', itemId: q.itemId, itemName: q.itemName } : {}),
        };
      }),
    };
  }
  function ownAttempt(actor, id, { open = false } = {}) {
    const att = store.get('quizAttempts', id);
    if (!att || (att.userId !== actor.id && !(isMgr(actor) && !open))) fail(404, 'Quiz not found');
    if (open && att.submittedAt) fail(409, 'This quiz was already handed in');
    return att;
  }
  function cleanQuiz(a, cur) {
    const title = text(a.title ?? cur?.title, 80);
    if (!title) fail(400, 'Give the quiz a name');
    const jobs = jobMap();
    const items = new Set(store.list('menuItems').map((i) => i.id));
    const questions = new Set(store.list('quizQuestions').map((q) => q.id));
    const types = list(a.types).filter((t) => QUESTION_TYPES.includes(t));
    const passing = a.passingScore === '' || a.passingScore == null ? null : Math.round(Number(a.passingScore));
    if (passing != null && !(passing >= 1 && passing <= 100)) fail(400, 'Passing score must be 1 to 100');
    const dueDate = a.dueDate ? String(a.dueDate) : null;
    if (dueDate && !DATE.test(dueDate)) fail(400, 'Pick a due date');
    return {
      title, description: para(a.description, 500),
      es: { title: text(a.es?.title, 80), description: para(a.es?.description, 500) },
      categories: uniq(list(a.categories).map((c) => text(c, 40))).slice(0, 30),
      itemIds: [...new Set(list(a.itemIds).filter((id) => items.has(id)))],
      questionIds: [...new Set(list(a.questionIds).filter((id) => questions.has(id)))],
      types: types.length ? [...new Set(types)] : [...QUESTION_TYPES],
      count: Math.min(50, Math.max(1, Math.round(Number(a.count) || 10))),
      passingScore: passing,
      jobCodeIds: [...new Set(list(a.jobCodeIds).filter((id) => jobs[id]))],
      dueDate,
      feedback: a.feedback === 'end' ? 'end' : 'each',
      active: a.active !== false,
    };
  }

  // ---------- leaderboard ----------
  /** Knowledge numbers for one person from their handed-in attempts. */
  function statsOf(attempts) {
    const bestByQuiz = new Map();
    const passed = new Set();
    const items = new Map();
    let answered = 0, right = 0, lastAt = '';
    for (const t of attempts) {
      bestByQuiz.set(t.quizId, Math.max(bestByQuiz.get(t.quizId) ?? 0, t.pct || 0));
      if (t.passed) passed.add(t.quizId);
      if (t.submittedAt > lastAt) lastAt = t.submittedAt;
      for (const q of t.questions) {
        answered++;
        const ok = !!q.answerId && q.answerId === q.correctId;
        if (ok) right++;
        if (!q.itemId) continue;
        const s = items.get(q.itemId) || { answered: 0, correct: 0 };
        s.answered++; if (ok) s.correct++;
        items.set(q.itemId, s);
      }
    }
    const bests = [...bestByQuiz.values()];
    const mastered = [...items.values()].filter((s) => s.answered >= MASTERY.answers && pct(s.correct, s.answered) >= MASTERY.pct).length;
    return {
      attempts: attempts.length,
      best: bests.length ? Math.round(bests.reduce((t, v) => t + v, 0) / bests.length) : null, // average of each quiz's best score
      avg: attempts.length ? Math.round(attempts.reduce((t, a) => t + (a.pct || 0), 0) / attempts.length) : null,
      passed: passed.size, mastered, answered, correct: right, lastAt,
    };
  }
  const SORTS = {
    best: (r) => [r.best ?? -1, r.mastered, r.passed, r.avg ?? -1],
    avg: (r) => [r.avg ?? -1, r.best ?? -1, r.mastered, r.passed],
    passed: (r) => [r.passed, r.best ?? -1, r.mastered, r.avg ?? -1],
    mastered: (r) => [r.mastered, r.best ?? -1, r.passed, r.avg ?? -1],
  };
  function personFilter({ jobCodeId, department, area } = {}) {
    const jobs = jobMap();
    return (u) => {
      const entries = u.jobCodes || [];
      if (jobCodeId && !entries.some((j) => j.jobCodeId === jobCodeId)) return false;
      if (department && !entries.some((j) => same(jobs[j.jobCodeId]?.department, department))) return false;
      if (area && !entries.some((j) => (j.areas || []).some((x) => same(x, area)))) return false;
      return true;
    };
  }
  function board(args = {}) {
    const byUser = new Map();
    for (const t of submitted()) (byUser.get(t.userId) || byUser.set(t.userId, []).get(t.userId)).push(t);
    const keep = personFilter(args);
    const sortKey = SORTS[args.sort] ? args.sort : 'best';
    const k = SORTS[sortKey];
    const rows = activeUsers().filter((u) => byUser.has(u.id) && keep(u)).map((u) => ({
      userId: u.id, name: u.name, color: u.color || null, positions: jobIdsOf(u), ...statsOf(byUser.get(u.id)),
    }));
    rows.sort((a, b) => {
      const x = k(a), y = k(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return a.name.localeCompare(b.name);
    });
    // People with exactly the same numbers share a rank (1, 2, 2, 4).
    rows.forEach((r, i) => { r.rank = i && k(r).join() === k(rows[i - 1]).join() ? rows[i - 1].rank : i + 1; });
    const notStarted = activeUsers().filter((u) => !byUser.has(u.id) && u.onSchedule !== false && keep(u)).map((u) => ({ userId: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name));
    return { rows, notStarted, sort: sortKey };
  }
  function filterOptions() {
    const jobs = store.list('jobCodes').filter((j) => !j.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return {
      jobCodes: jobs.map((j) => ({ id: j.id, name: j.name })),
      departments: uniq(jobs.map((j) => j.department)),
      areas: uniq([...(settings().areas || []), ...activeUsers().flatMap((u) => (u.jobCodes || []).flatMap((j) => j.areas || []))]),
    };
  }

  // ---------- manual ----------
  const ackId = (pageId, userId) => `${pageId}:${userId}`;
  const ackCurrent = (page, ack) => !!ack && (ack.version || 0) >= (page.ackVersion || 1);
  const readers = () => activeUsers().filter((u) => u.onSchedule !== false || atLeast(u, 'manager'));
  function pageView(actor, p, { body = true } = {}) {
    const mine = store.get('manualAcks', ackId(p.id, actor.id));
    const out = {
      id: p.id, sectionId: p.sectionId, title: p.title, order: p.order ?? 0, version: p.version || 1, ackVersion: p.ackVersion || 1,
      isCallOut: !!p.isCallOut, updatedAt: p.updatedAt || '', updatedBy: p.updatedBy ? nameOf(p.updatedBy) : '',
      my: { ackedAt: mine?.at || null, current: ackCurrent(p, mine) },
      es: { title: p.es?.title || '', ...(body ? { body: p.es?.body || '' } : {}) },
      ...(body ? { body: p.body || '' } : {}),
    };
    if (isMgr(actor)) {
      const acks = new Map(store.list('manualAcks', (a) => a.pageId === p.id).map((a) => [a.userId, a]));
      const people = readers();
      const done = people.filter((u) => ackCurrent(p, acks.get(u.id)));
      out.ackCount = done.length;
      out.readerCount = people.length;
      if (body) {
        out.acks = done.map((u) => ({ userId: u.id, name: u.name, at: acks.get(u.id).at })).sort((a, b) => a.name.localeCompare(b.name));
        out.missing = people.filter((u) => !ackCurrent(p, acks.get(u.id)))
          .map((u) => ({ userId: u.id, name: u.name, oldAt: acks.get(u.id)?.at || null })).sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    return out;
  }
  const sections = () => store.list('manualSections').sort(byOrder);
  const pagesIn = (sectionId) => store.list('manualPages', (p) => p.sectionId === sectionId).sort(byOrder);
  function askToReread(p, actor) {
    notifyEach(readers().filter((u) => u.id !== actor.id), (T, lang) => T.nReread(localize(p, lang).title), `#/training/manual/${p.id}`);
  }

  // ---------- manager on duty ----------
  const absNow = () => { const n = now(); return daysBetween('2000-01-01', todayStr(n)) * 1440 + n.getHours() * 60 + n.getMinutes(); };
  const managerJob = isManagerJob; // core/mod.js: the same rule as the printed schedule's M.O.D. block
  const canBeMod = (u) => !!u && u.active !== false && (atLeast(u, 'supervisor') || jobIdsOf(u).some((id) => managerJob(store.get('jobCodes', id))));
  /** Published shifts on `date` (and the night before's, which can run past midnight) worked by manager-level people. */
  function managerShifts(date) {
    const st = settings();
    const jobs = jobMap();
    const out = [];
    for (const s of store.list('shifts', (x) => x.published && x.userId && (x.date === date || x.date === addDays(date, -1)))) {
      const u = store.get('users', s.userId);
      if (!u || u.active === false) continue;
      const job = jobs[s.jobCodeId];
      if (!isModShift(u, job)) continue;
      const eff = effectiveShift(s, st);
      const [from, to] = shiftSpan(eff);
      out.push({ shift: s, user: u, job, mgrJob: managerJob(job), kitchen: KITCHEN_JOB.test(`${job?.name || ''} ${job?.department || ''}`), from, to, end: eff.end });
    }
    return out;
  }
  // Who's in charge when several managers are on: a manager job beats a manager working another job, the front of
  // house beats the kitchen, and the one who came in last has taken over.
  const charge = (a, b) => (a.mgrJob === b.mgrJob ? 0 : a.mgrJob ? -1 : 1) || (a.kitchen === b.kitchen ? 0 : a.kitchen ? 1 : -1) || b.from - a.from || a.user.name.localeCompare(b.user.name);
  const personOut = (u, x) => ({
    id: u.id, name: u.name, phone: u.phone || '',
    shift: x ? { date: x.shift.date, start: x.shift.start, end: x.shift.end || x.end, estimatedEnd: !x.shift.end, jobName: x.job?.name || '' } : null,
  });
  function modOn(date) {
    const cfg = config();
    const isToday = date === today();
    const t = absNow();
    const all = managerShifts(date);
    const ownDay = all.filter((x) => x.shift.date === date);
    const ov = store.get('modOverrides', date);
    const ovUser = ov ? store.get('users', ov.userId) : null;
    const onNow = isToday ? all.filter((x) => x.from <= t && t < x.to).sort(charge) : [];
    let status = 'none', chosen = null, user = null;
    if (ovUser && ovUser.active !== false) {
      status = 'override'; user = ovUser;
      chosen = [...onNow, ...ownDay].find((x) => x.user.id === ovUser.id) || null;
      if (!chosen) {
        const s = store.list('shifts', (x) => x.published && x.userId === ovUser.id && x.date === date).sort((a, b) => a.start.localeCompare(b.start))[0];
        if (s) chosen = { shift: s, user: ovUser, job: store.get('jobCodes', s.jobCodeId), end: effectiveShift(s, settings()).end };
      }
    } else if (onNow.length) {
      status = 'now'; chosen = onNow[0];
    } else {
      const later = ownDay.filter((x) => !isToday || x.from > t).sort((a, b) => a.from - b.from || charge(a, b));
      if (later.length) { status = isToday ? 'next' : 'planned'; chosen = later[0]; }
    }
    user ||= chosen?.user || null;
    return {
      date, status, callOutPhone: cfg.callOutPhone,
      person: user ? personOut(user, chosen) : null,
      alsoOn: onNow.filter((x) => x.user.id !== user?.id).map((x) => ({ id: x.user.id, name: x.user.name }))
        .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i),
      managers: managersOn(date, { all, onNow, isToday, t, inCharge: user }),
    };
  }
  /**
   * Every manager on the schedule that day, one entry each: who's on now first (the one in charge at the top),
   * then later today, then earlier today (latest finish first). Another day: by start time ('planned').
   * state: 'now' | 'later' | 'earlier' | 'planned'; inCharge: the manager on duty the card names.
   */
  function managersOn(date, { all, onNow, isToday, t, inCharge }) {
    const seen = new Set();
    const pick = (list, state) => list.filter((x) => !seen.has(x.user.id) && seen.add(x.user.id)).map((x) => ({ ...personOut(x.user, x), state, inCharge: x.user.id === inCharge?.id }));
    const own = all.filter((x) => x.shift.date === date);
    const out = isToday ? [
      ...pick([...onNow].sort((a, b) => (a.user.id === inCharge?.id ? -1 : b.user.id === inCharge?.id ? 1 : 0)), 'now'),
      ...pick(own.filter((x) => x.from > t).sort((a, b) => a.from - b.from || charge(a, b)), 'later'),
      ...pick(own.filter((x) => x.to <= t).sort((a, b) => b.to - a.to || charge(a, b)), 'earlier'),
    ] : pick(own.sort((a, b) => a.from - b.from || charge(a, b)), 'planned');
    // A manager picked by hand who isn't on the schedule that day still shows, first.
    if (inCharge && !seen.has(inCharge.id)) out.unshift({ ...personOut(inCharge, null), state: isToday ? 'now' : 'planned', inCharge: true });
    return out;
  }
  function quizPhoto(actor, attemptId, qKey) {
    const p = quizPhotoFor(store, actor, attemptId, qKey);
    if (!p) fail(404, 'Photo not found');
    return p;
  }

  // ---------- API ----------
  const api = {
    // ----- settings (Settings → Training) -----
    'training.settings.get': (actor) => {
      needAuth(actor);
      const cfg = config();
      const out = { leaderboard: cfg.leaderboard, callOutPhone: cfg.callOutPhone, categoryOrder: cfg.categoryOrder, categoryEs: cfg.categoryEs };
      return isMgr(actor) ? { ...out, defaults: cfg.defaults, departments: knownDepartments() } : out;
    },
    'training.saveSettings': (actor, a = {}) => {
      needAdmin(actor);
      const patch = {};
      if ('leaderboard' in a) patch.leaderboard = a.leaderboard === 'managers' ? 'managers' : 'all';
      if ('callOutPhone' in a) patch.callOutPhone = cleanPhone(a.callOutPhone);
      if ('categoryOrder' in a) patch.categoryOrder = uniq(list(a.categoryOrder).map((c) => text(c, 40))).slice(0, 40);
      if ('categoryEs' in a) {
        patch.categoryEs = {};
        for (const [k, v] of Object.entries(a.categoryEs && typeof a.categoryEs === 'object' ? a.categoryEs : {}).slice(0, 60)) {
          if (text(k, 40) && text(v, 40)) patch.categoryEs[text(k, 40)] = text(v, 40);
        }
      }
      if ('defaults' in a) {
        patch.defaults = {};
        for (const g of FIELD_GROUPS) if (a.defaults?.[g]) patch.defaults[g] = cleanRule(a.defaults[g]);
      }
      patch.updatedAt = now().toISOString();
      if (store.get('trainingConfig', 'main')) store.update('trainingConfig', 'main', patch); else store.insert('trainingConfig', { id: 'main', ...patch });
      return api['training.settings.get'](actor);
    },
    // What's waiting for me: assigned quizzes not passed yet, manual pages to read.
    'training.summary': (actor) => {
      needAuth(actor);
      const lang = userLang(actor);
      const mine = submitted((t) => t.userId === actor.id);
      const quizzes = store.list('quizzes', (q) => q.active !== false && assignedTo(q, actor) && !mine.some((t) => t.quizId === q.id && t.passed))
        .map((q) => ({ id: q.id, title: localize(q, lang).title, dueDate: q.dueDate || null, overdue: !!q.dueDate && q.dueDate < today() }))
        .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
      const pages = store.list('manualPages').sort(byOrder).filter((p) => !ackCurrent(p, store.get('manualAcks', ackId(p.id, actor.id))))
        .map((p) => ({ id: p.id, title: localize(p, lang).title }));
      return { quizzes, pages, stats: statsOf(mine) };
    },

    // ----- menu study guide -----
    'menu.list': (actor) => {
      needAuth(actor);
      const cfg = config();
      const items = store.list('menuItems').sort(byOrder);
      const custom = uniq(items.flatMap((i) => i.allergens || []).filter((a) => !MAJOR_BY_ID[a]));
      return {
        items: items.map((it) => itemView(actor, it, cfg)),
        categories: categoriesOf(items, cfg),
        categoryEs: cfg.categoryEs,
        allergens: [...MAJOR_ALLERGENS, ...custom.map((id) => ({ id, label: allergenLabel(id), es: allergenLabel(id), custom: true }))],
        dietary: uniq([...DIETARY_TAGS, ...items.flatMap((i) => i.dietary || [])]),
        ...(isMgr(actor) ? { defaults: cfg.defaults, departments: knownDepartments(), suggestedCategories: uniq([...cfg.categoryOrder, ...items.map((i) => i.category)]) } : {}),
      };
    },
    'menu.get': (actor, { id }) => {
      needAuth(actor);
      const it = store.get('menuItems', id);
      if (!it) fail(404, 'Menu item not found');
      return itemView(actor, it, config());
    },
    'menu.save': (actor, a = {}) => {
      needMgr(actor);
      const cur = a.id ? store.get('menuItems', a.id) : null;
      if (a.id && !cur) fail(404, 'Menu item not found');
      const doc = { ...cleanItem(a, cur), updatedAt: now().toISOString(), updatedBy: actor.id };
      const out = cur ? store.update('menuItems', cur.id, doc)
        : store.insert('menuItems', { id: uid('mnu'), ...doc, photos: [], order: Math.max(0, ...store.list('menuItems').map((i) => (i.order ?? 0) + 1)), createdAt: now().toISOString() });
      return itemView(actor, out, config());
    },
    'menu.delete': (actor, { id }) => {
      needMgr(actor);
      const it = store.get('menuItems', id);
      if (!it) fail(404, 'Menu item not found');
      for (const p of it.photos || []) store.remove('menuPhotos', p.id);
      for (const q of store.list('quizQuestions', (x) => x.itemId === id)) store.update('quizQuestions', q.id, { itemId: null, category: q.category || it.category });
      for (const z of store.list('quizzes', (x) => (x.itemIds || []).includes(id))) store.update('quizzes', z.id, { itemIds: z.itemIds.filter((x) => x !== id) });
      store.remove('menuItems', id);
      return { ok: true };
    },
    'menu.reorder': (actor, { ids }) => {
      needMgr(actor);
      (Array.isArray(ids) ? ids : []).forEach((id, i) => { if (store.get('menuItems', id)) store.update('menuItems', id, { order: i }); });
      return { ok: true };
    },
    // One photo per request (the browser resizes it first), so an upload stays far under the request size limit.
    'menu.addPhoto': (actor, { itemId, dataUrl, w, h }) => {
      needMgr(actor);
      const it = store.get('menuItems', itemId);
      if (!it) fail(404, 'Menu item not found');
      if ((it.photos || []).length >= PHOTOS_PER_ITEM) fail(400, `An item can have up to ${PHOTOS_PER_ITEM} photos. Delete one first.`);
      const { mime, data, bytes } = checkPhoto(dataUrl, fail);
      const dim = (v) => Math.max(0, Math.min(10000, Math.round(Number(v) || 0)));
      const photo = { id: uid('mph'), w: dim(w), h: dim(h), bytes };
      store.insert('menuPhotos', { ...photo, itemId, mime, data, createdAt: now().toISOString(), createdBy: actor.id });
      const photos = [...(it.photos || []), photo];
      store.update('menuItems', itemId, { photos, updatedAt: now().toISOString() });
      return { photo: { id: photo.id, w: photo.w, h: photo.h }, photos: photos.map(({ id, w: pw, h: ph }) => ({ id, w: pw, h: ph })) };
    },
    'menu.removePhoto': (actor, { itemId, photoId }) => {
      needMgr(actor);
      const it = store.get('menuItems', itemId);
      if (!it) fail(404, 'Menu item not found');
      if (!(it.photos || []).some((p) => p.id === photoId)) fail(404, 'Photo not found');
      store.remove('menuPhotos', photoId);
      const photos = it.photos.filter((p) => p.id !== photoId);
      store.update('menuItems', itemId, { photos });
      return { photos: photos.map(({ id, w, h }) => ({ id, w, h })) };
    },
    'menu.reorderPhotos': (actor, { itemId, photoIds }) => {
      needMgr(actor);
      const it = store.get('menuItems', itemId);
      if (!it) fail(404, 'Menu item not found');
      const have = it.photos || [];
      const ids = Array.isArray(photoIds) ? photoIds : [];
      if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((id) => have.some((p) => p.id === id))) fail(400, 'Those photos don’t match this item');
      const photos = ids.map((id) => have.find((p) => p.id === id));
      store.update('menuItems', itemId, { photos });
      return { photos: photos.map(({ id, w, h }) => ({ id, w, h })) };
    },
    // The photo itself as a data URL (the demo has no server to serve /api/training/photos/:id).
    'menu.photo.get': (actor, { id }) => {
      needAuth(actor);
      const p = store.get('menuPhotos', id);
      if (!p?.data) fail(404, 'Photo not found'); // on a server the bytes aren't cached: /api/training/photos/:id serves them
      return { id: p.id, dataUrl: `data:${p.mime};base64,${p.data}` };
    },

    // ----- quizzes -----
    'quiz.list': (actor) => {
      needAuth(actor);
      const mine = submitted((t) => t.userId === actor.id);
      const open = store.list('quizAttempts', (t) => t.userId === actor.id && !t.submittedAt);
      const all = submitted();
      return store.list('quizzes', (q) => isMgr(actor) || q.active !== false).map((q) => {
        const tries = mine.filter((t) => t.quizId === q.id);
        const row = {
          id: q.id, title: q.title, description: q.description || '', es: { title: q.es?.title || '', description: q.es?.description || '' },
          count: q.count, passingScore: q.passingScore ?? null, dueDate: q.dueDate || null, feedback: q.feedback,
          categories: q.categories || [], itemCount: (q.itemIds || []).length, jobCodeIds: q.jobCodeIds || [], active: q.active !== false,
          assigned: assignedTo(q, actor),
          my: { attempts: tries.length, best: tries.length ? Math.max(...tries.map((t) => t.pct || 0)) : null, passed: tries.some((t) => t.passed),
            lastAt: tries.map((t) => t.submittedAt).sort().pop() || null, openAttemptId: open.find((t) => t.quizId === q.id)?.id || null },
        };
        if (isMgr(actor)) {
          const people = assignedUsers(q);
          const passedBy = new Set(all.filter((t) => t.quizId === q.id && t.passed).map((t) => t.userId));
          row.stats = { takers: new Set(all.filter((t) => t.quizId === q.id).map((t) => t.userId)).size, passed: passedBy.size,
            assigned: people.length, assignedPassed: people.filter((u) => passedBy.has(u.id)).length };
        }
        return row;
      }).sort((a, b) => (b.assigned && !b.my.passed) - (a.assigned && !a.my.passed) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title));
    },
    'quiz.get': (actor, { id }) => {
      needMgr(actor);
      const q = quizById(id);
      if (!q) fail(404, 'Quiz not found');
      return q;
    },
    'quiz.save': (actor, a = {}) => {
      needMgr(actor);
      const cur = a.id ? quizById(a.id) : null;
      if (a.id && !cur) fail(404, 'Quiz not found');
      const doc = { ...cleanQuiz(a, cur), updatedAt: now().toISOString() };
      const before = new Set(cur && cur.active !== false ? assignedUsers(cur).map((u) => u.id) : []);
      const out = cur ? store.update('quizzes', cur.id, doc) : store.insert('quizzes', { id: uid('quz'), ...doc, createdAt: now().toISOString(), createdBy: actor.id });
      if (out.active !== false) {
        const people = assignedUsers(out).filter((u) => u.id !== actor.id);
        const passed = new Set(submitted((t) => t.quizId === out.id && t.passed).map((t) => t.userId));
        const due = (lang) => (out.dueDate ? dayLabel(out.dueDate, lang) : '');
        notifyEach(people.filter((u) => !before.has(u.id)), (T, lang) => T.nNewQuiz(localize(out, lang).title, due(lang)), '#/training/quizzes');
        if (cur && cur.dueDate !== out.dueDate && out.dueDate) {
          notifyEach(people.filter((u) => before.has(u.id) && !passed.has(u.id)), (T, lang) => T.nQuizDue(localize(out, lang).title, due(lang)), '#/training/quizzes');
        }
      }
      return out;
    },
    'quiz.delete': (actor, { id }) => {
      needMgr(actor);
      if (!quizById(id)) fail(404, 'Quiz not found');
      for (const t of store.list('quizAttempts', (x) => x.quizId === id && !x.submittedAt)) store.remove('quizAttempts', t.id);
      store.remove('quizzes', id); // handed-in attempts stay in people's history
      return { ok: true };
    },
    'quiz.questions.list': (actor) => {
      needMgr(actor);
      return store.list('quizQuestions').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    'quiz.saveQuestion': (actor, a = {}) => {
      needMgr(actor);
      const cur = a.id ? store.get('quizQuestions', a.id) : null;
      if (a.id && !cur) fail(404, 'Question not found');
      const kind = a.kind === 'tf' ? 'tf' : 'mc';
      const qText = para(a.text, 400);
      if (!qText) fail(400, 'Write the question');
      const itemId = a.itemId && store.get('menuItems', a.itemId) ? a.itemId : null;
      let choices = [], esChoices = [], correct;
      if (kind === 'tf') correct = a.correct === true || a.correct === 'true';
      else {
        const raw = list(a.choices).map((c) => text(c, 160));
        const rawEs = Array.isArray(a.es?.choices) ? a.es.choices.map((c) => text(c, 160)) : [];
        const n = Number(a.correct);
        if (raw.filter(Boolean).length < 2) fail(400, 'Add at least two answers');
        if (!Number.isInteger(n) || !raw[n]) fail(400, 'Mark the right answer');
        const keepIdx = raw.map((c, i) => (c ? i : -1)).filter((i) => i >= 0).slice(0, 6);
        choices = keepIdx.map((i) => raw[i]);
        esChoices = keepIdx.map((i) => rawEs[i] || '');
        correct = keepIdx.indexOf(n);
        if (correct < 0) fail(400, 'Mark the right answer');
      }
      const doc = {
        kind, text: qText, choices, correct, itemId, category: itemId ? '' : text(a.category, 40), audience: a.audience === 'recipe' ? 'recipe' : 'all', explain: para(a.explain, 400),
        es: { text: para(a.es?.text, 400), choices: esChoices, explain: para(a.es?.explain, 400) },
        updatedAt: now().toISOString(),
      };
      return cur ? store.update('quizQuestions', cur.id, doc) : store.insert('quizQuestions', { id: uid('qq'), ...doc, createdAt: now().toISOString(), createdBy: actor.id });
    },
    'quiz.deleteQuestion': (actor, { id }) => {
      needMgr(actor);
      if (!store.remove('quizQuestions', id)) fail(404, 'Question not found');
      for (const z of store.list('quizzes', (x) => (x.questionIds || []).includes(id))) store.update('quizzes', z.id, { questionIds: z.questionIds.filter((x) => x !== id) });
      return { ok: true };
    },
    // Start (or pick up where you left off). The answers stay on the server.
    'quiz.start': (actor, { quizId, fresh = false }) => {
      needAuth(actor);
      const quiz = quizById(quizId);
      if (!quiz || (quiz.active === false && !isMgr(actor))) fail(404, 'Quiz not found');
      const open = store.list('quizAttempts', (t) => t.userId === actor.id && t.quizId === quizId && !t.submittedAt);
      if (open.length && !fresh) return attemptView(open[0]);
      for (const t of open) store.remove('quizAttempts', t.id);
      const questions = generate(actor, quiz);
      if (!questions.length) fail(400, 'This quiz has no questions yet. A manager needs to add menu items (or questions) first.');
      const lang = userLang(actor);
      const att = store.insert('quizAttempts', {
        id: uid('qat'), quizId, userId: actor.id, title: localize(quiz, lang).title, lang, feedback: quiz.feedback || 'each', passingScore: quiz.passingScore ?? null,
        startedAt: now().toISOString(), submittedAt: null, questions,
      });
      return attemptView(att);
    },
    'quiz.answer': (actor, { attemptId, key: qKey, choiceId }) => {
      needAuth(actor);
      const att = ownAttempt(actor, attemptId, { open: true });
      const i = att.questions.findIndex((q) => q.key === qKey);
      if (i < 0) fail(404, 'Question not found');
      const q = att.questions[i];
      if (!q.choices.some((c) => c.id === choiceId)) fail(400, 'Pick one of the answers');
      if (att.feedback === 'each' && q.answerId) fail(409, 'You already answered this one');
      const questions = att.questions.map((x, k) => (k === i ? { ...x, answerId: choiceId } : x));
      store.update('quizAttempts', att.id, { questions });
      if (att.feedback !== 'each') return { key: q.key, saved: true };
      return { key: q.key, correct: choiceId === q.correctId, correctId: q.correctId, explain: q.explain || '', itemName: q.itemName };
    },
    // Hand it in: graded here, then the answers come back.
    'quiz.submit': (actor, { attemptId, answers = {} }) => {
      needAuth(actor);
      const att = ownAttempt(actor, attemptId, { open: true });
      let score = 0;
      const questions = att.questions.map((q) => {
        let answerId = q.answerId || null;
        const given = answers && typeof answers === 'object' ? answers[q.key] : null;
        if (given && q.choices.some((c) => c.id === given) && (att.feedback !== 'each' || !answerId)) answerId = given;
        if (answerId && answerId === q.correctId) score++;
        return { ...q, answerId };
      });
      const total = questions.length;
      const p = pct(score, total);
      const passed = att.passingScore == null ? true : p >= att.passingScore;
      const out = store.update('quizAttempts', att.id, { questions, score, total, pct: p, passed, submittedAt: now().toISOString() });
      return attemptView(out);
    },
    'quiz.attempts.list': (actor, { userId } = {}) => {
      needAuth(actor);
      const id = userId || actor.id;
      if (id !== actor.id && !isMgr(actor)) fail(403, 'Managers only');
      return submitted((t) => t.userId === id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .map((t) => ({ id: t.id, quizId: t.quizId, title: t.title, submittedAt: t.submittedAt, score: t.score, total: t.total, pct: t.pct, passed: t.passed }));
    },
    'quiz.attempt.get': (actor, { id }) => {
      needAuth(actor);
      return attemptView(ownAttempt(actor, id));
    },
    // A quiz photo that doesn't say which item it is (the demo has no server for /api/training/quiz-photo).
    'quiz.photo.get': (actor, { attemptId, key: qKey }) => {
      needAuth(actor);
      const p = quizPhoto(actor, attemptId, qKey);
      if (!p?.data) fail(404, 'Photo not found');
      return { dataUrl: `data:${p.mime};base64,${p.data}` };
    },

    // ----- leaderboard -----
    'leaderboard.get': (actor, args = {}) => {
      needAuth(actor);
      const cfg = config();
      const options = filterOptions();
      const { rows, notStarted, sort } = board(args);
      const me = rows.find((r) => r.userId === actor.id) || { userId: actor.id, name: actor.name, positions: jobIdsOf(actor), ...statsOf(submitted((t) => t.userId === actor.id)), rank: null };
      if (cfg.leaderboard === 'managers' && !isMgr(actor)) return { visible: false, setting: cfg.leaderboard, me, filters: options, sort, mastery: MASTERY };
      return { visible: true, setting: cfg.leaderboard, rows, me, filters: options, sort, mastery: MASTERY, ...(isMgr(actor) ? { notStarted } : {}) };
    },
    // One person's strong and weak spots, for managers deciding who goes where (and for the person themself).
    'leaderboard.person.get': (actor, { userId }) => {
      needAuth(actor);
      const id = userId || actor.id;
      if (id !== actor.id && !isMgr(actor)) fail(403, 'Managers only');
      const u = store.get('users', id);
      if (!u) fail(404, 'Person not found');
      const lang = userLang(actor);
      const attempts = submitted((t) => t.userId === id);
      const items = new Map(store.list('menuItems').map((i) => [i.id, i]));
      const byItem = new Map(), byCat = new Map();
      for (const t of attempts) for (const q of t.questions) {
        const ok = !!q.answerId && q.answerId === q.correctId;
        const it = items.get(q.itemId);
        const cat = it?.category || q.category;
        if (cat) { const c = byCat.get(key(cat)) || { category: cat, answered: 0, correct: 0 }; c.answered++; if (ok) c.correct++; byCat.set(key(cat), c); }
        if (q.itemId) {
          const s = byItem.get(q.itemId) || { itemId: q.itemId, name: it ? localizeItem(it, lang).name : q.itemName, category: cat || '', answered: 0, correct: 0 };
          s.answered++; if (ok) s.correct++; byItem.set(q.itemId, s);
        }
      }
      const finish = (arr) => arr.map((s) => ({ ...s, pct: pct(s.correct, s.answered) })).sort((a, b) => a.pct - b.pct || b.answered - a.answered);
      const passedQuiz = new Set(attempts.filter((t) => t.passed).map((t) => t.quizId));
      return {
        user: { id: u.id, name: u.name, positions: jobIdsOf(u) },
        stats: statsOf(attempts),
        categories: finish([...byCat.values()]),
        items: finish([...byItem.values()]).map((s) => ({ ...s, mastered: s.answered >= MASTERY.answers && s.pct >= MASTERY.pct })),
        attempts: attempts.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map((t) => ({ id: t.id, quizId: t.quizId, title: t.title, submittedAt: t.submittedAt, pct: t.pct, passed: t.passed })),
        assigned: store.list('quizzes', (q) => q.active !== false && assignedTo(q, u)).map((q) => ({ id: q.id, title: localize(q, lang).title, dueDate: q.dueDate || null, passed: passedQuiz.has(q.id) })),
      };
    },

    // ----- employee manual -----
    'manual.list': (actor) => {
      needAuth(actor);
      return { sections: sections().map((s) => ({ id: s.id, title: s.title, es: { title: s.es?.title || '' }, order: s.order ?? 0, pages: pagesIn(s.id).map((p) => pageView(actor, p, { body: false })) })) };
    },
    'manual.get': (actor, { id, callOut } = {}) => {
      needAuth(actor);
      const p = callOut ? store.list('manualPages', (x) => x.isCallOut)[0] : store.get('manualPages', id);
      if (!p) { if (callOut) return null; fail(404, 'Page not found'); }
      const sec = store.get('manualSections', p.sectionId);
      return { ...pageView(actor, p), sectionTitle: sec?.title || '', sectionEs: sec?.es?.title || '' };
    },
    'manual.saveSection': (actor, a = {}) => {
      needMgr(actor);
      const title = text(a.title, 80);
      if (!title) fail(400, 'Give the section a name');
      const es = { title: text(a.es?.title, 80) };
      if (a.id) { if (!store.get('manualSections', a.id)) fail(404, 'Section not found'); return store.update('manualSections', a.id, { title, es }); }
      return store.insert('manualSections', { id: uid('msec'), title, es, order: Math.max(0, ...sections().map((s) => (s.order ?? 0) + 1)) });
    },
    'manual.deleteSection': (actor, { id }) => {
      needMgr(actor);
      if (!store.get('manualSections', id)) fail(404, 'Section not found');
      const n = pagesIn(id).length;
      if (n) fail(409, `Move or delete its ${n} page${n === 1 ? '' : 's'} first`);
      store.remove('manualSections', id);
      return { ok: true };
    },
    'manual.savePage': (actor, a = {}) => {
      needMgr(actor);
      const cur = a.id ? store.get('manualPages', a.id) : null;
      if (a.id && !cur) fail(404, 'Page not found');
      const sectionId = a.sectionId || cur?.sectionId;
      if (!store.get('manualSections', sectionId)) fail(400, 'Pick a section');
      const title = text(a.title ?? cur?.title, 120);
      if (!title) fail(400, 'Give the page a title');
      const body = para(a.body ?? cur?.body, 30000);
      const es = { title: text(a.es?.title ?? cur?.es?.title, 120), body: para(a.es?.body ?? cur?.es?.body, 30000) };
      const isCallOut = a.isCallOut == null ? !!cur?.isCallOut : !!a.isCallOut;
      if (isCallOut) for (const p of store.list('manualPages', (x) => x.isCallOut && x.id !== cur?.id)) store.update('manualPages', p.id, { isCallOut: false });
      const stamp = { updatedAt: now().toISOString(), updatedBy: actor.id };
      if (!cur) {
        return pageView(actor, store.insert('manualPages', { id: uid('mpg'), sectionId, title, body, es, isCallOut, version: 1, ackVersion: 1, order: Math.max(0, ...pagesIn(sectionId).map((p) => (p.order ?? 0) + 1)), ...stamp }));
      }
      const changed = body !== (cur.body || '') || title !== cur.title || es.body !== (cur.es?.body || '') || es.title !== (cur.es?.title || '');
      const version = (cur.version || 1) + (changed ? 1 : 0);
      const reack = !!a.reack;
      const moved = sectionId !== cur.sectionId ? { order: Math.max(0, ...pagesIn(sectionId).map((p) => (p.order ?? 0) + 1)) } : {};
      const out = store.update('manualPages', cur.id, { sectionId, title, body, es, isCallOut, version, ...(reack ? { ackVersion: version } : {}), ...moved, ...stamp });
      if (reack) askToReread(out, actor);
      return pageView(actor, out);
    },
    'manual.deletePage': (actor, { id }) => {
      needMgr(actor);
      if (!store.remove('manualPages', id)) fail(404, 'Page not found');
      for (const a of store.list('manualAcks', (x) => x.pageId === id)) store.remove('manualAcks', a.id);
      return { ok: true };
    },
    // Order sections (sectionIds) or the pages in one section (pageIds).
    'manual.reorder': (actor, { sectionIds, pageIds }) => {
      needMgr(actor);
      (Array.isArray(sectionIds) ? sectionIds : []).forEach((id, i) => { if (store.get('manualSections', id)) store.update('manualSections', id, { order: i }); });
      (Array.isArray(pageIds) ? pageIds : []).forEach((id, i) => { if (store.get('manualPages', id)) store.update('manualPages', id, { order: i }); });
      return { ok: true };
    },
    'manual.ack': (actor, { id }) => {
      needAuth(actor);
      const p = store.get('manualPages', id);
      if (!p) fail(404, 'Page not found');
      const doc = { id: ackId(p.id, actor.id), pageId: p.id, userId: actor.id, version: p.version || 1, at: now().toISOString() };
      if (store.get('manualAcks', doc.id)) store.update('manualAcks', doc.id, doc); else store.insert('manualAcks', doc);
      return pageView(actor, p);
    },
    // After an edit: everyone has to read it again (their old "I've read this" no longer counts).
    'manual.requireReack': (actor, { id }) => {
      needMgr(actor);
      const p = store.get('manualPages', id);
      if (!p) fail(404, 'Page not found');
      const out = store.update('manualPages', id, { ackVersion: p.version || 1 });
      askToReread(out, actor);
      return pageView(actor, out);
    },

    // ----- manager on duty -----
    // Everyone can see who's in charge right now and their phone number (and the call-out line). That's the only
    // coworker phone number staff can get here: everyone else's stays with supervisors and up.
    'mod.get': (actor, { date } = {}) => {
      needAuth(actor);
      const d = isMgr(actor) && DATE.test(date || '') ? date : today();
      const out = modOn(d);
      // Every manager on today's schedule can be called. Someone who already went home keeps their number
      // only for shift leads and up (who see everyone's contacts anyway).
      out.managers = out.managers.map((m) => (m.state === 'earlier' && !canSeeContacts(actor) ? { ...m, phone: '' } : m));
      if (!isMgr(actor)) return out;
      const scheduled = managerShifts(d).filter((x) => x.shift.date === d).sort((a, b) => a.from - b.from)
        .map((x) => ({ id: x.user.id, name: x.user.name, start: x.shift.start, end: x.shift.end || null, jobName: x.job?.name || '' }));
      const candidates = activeUsers().filter(canBeMod).map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name));
      return { ...out, override: store.get('modOverrides', d)?.userId || null, scheduled, candidates };
    },
    'mod.setOverride': (actor, { date, userId }) => {
      needMgr(actor);
      const d = date || today();
      if (!DATE.test(d)) fail(400, 'Pick a date');
      if (!userId) { store.remove('modOverrides', d); return api['mod.get'](actor, { date: d }); }
      const u = store.get('users', userId);
      if (!canBeMod(u)) fail(400, 'Pick a manager or supervisor');
      const doc = { id: d, date: d, userId, setBy: actor.id, at: now().toISOString() };
      if (store.get('modOverrides', d)) store.update('modOverrides', d, doc); else store.insert('modOverrides', doc);
      return api['mod.get'](actor, { date: d });
    },
  };
  return api;
}

/** The photo document for a quiz question, if the caller may see it (also used by server/training-routes.js). */
export function quizPhotoFor(store, actor, attemptId, qKey) {
  const att = store.get('quizAttempts', attemptId);
  if (!att || (att.userId !== actor.id && !canManageSchedule(actor))) return null;
  const q = att.questions.find((x) => x.key === qKey);
  return q?.photoId ? store.get('menuPhotos', q.photoId) : null;
}
