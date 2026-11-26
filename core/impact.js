// Positive impact: who guests single out. Three kinds of credit, all per person:
//   * mentions in reviews (OpenTable, Google, Yelp, TripAdvisor…): a staff name in the review's text,
//     counted by star rating, with 5-star mentions as the headline number;
//   * reservation requests: a guest asking for someone ("request Sarah", "sit in Mike's section",
//     OpenTable's requested-server field when an export has one);
//   * kudos a manager adds by hand: a shout-out on Google, Yelp or TripAdvisor, in person, on a card.
//
// Matching names (findMentions, findRequests). Each person is known by their first name, the usual
// nicknames for it (Michael → Mike, Manuel → Manny, Victoria → Tori…), their full name when it has two words
// (Mary Ann), and any "also known as" names a manager adds. A name that's also an everyday word (Will,
// Rose, Ever, Grace, Flor…) only counts with something that says it's a person: a capital letter AND a
// cue such as "our server Will", "thanks to Will", "Will was amazing", and never after "the", "a glass of"
// or before "be", "definitely", "recommend". Words a manager lists (and the restaurant's own name and
// rooms) are never names.
// Who it is. One person with that name: theirs. Several (two Alexes): "Alex D." settles it, then the
// server OpenTable recorded on the review, then who actually worked that day (a published shift or a
// clock-in on the dining date); if that still leaves more than one, the mention waits in "Needs review"
// with a picker. A unique name whose person didn't work that day (when the day has shifts) waits too.
// Unambiguous matches are confirmed automatically. Managers confirm, reassign or dismiss any match;
// their decision sticks when the reviews are imported again or the names change.
//
// Collections: guestReviews (any source), otReservations (core/opentable.js), impactMentions, kudos,
// integrations 'impact' (settings: notifications on/off, ignored words; imports; remembered columns).
// Users carry `aka` (also-known-as names). Managers and up see everyone; everyone else sees only their own.
import { aliasesOf } from './names.js';
import { uid } from './store.js';
import { addDays, todayStr } from './time.js';
import { canManageSchedule, canChangeSettings } from './roles.js';
import { seasonOf, seasonById, seasonsBetween } from './seasons.js';
import { scrub, shortName, reviewPrint, cleanId, hashKey } from './guest-csv.js';

export const INTEGRATION_ID = 'impact';
// Reviews are one model whatever the source (guestReviews: source, externalId, rating, text, date, diningDate,
// reviewer, server, replied, reply): a connector for Google Business Profile or Yelp only has to fetch and call
// applyReviews(); matching, reports, notifications and manager alerts come with it.
export const REVIEW_SOURCES = ['opentable', 'google', 'yelp', 'tripadvisor', 'facebook', 'manual', 'other'];
export const LOW_RATING = 2; // a new review at or below this alerts the managers
export const KUDOS_SOURCES = ['google', 'yelp', 'tripadvisor', 'opentable', 'facebook', 'inPerson', 'card', 'phone', 'email', 'other'];
export const NOTIFY_WITHIN_DAYS = 30; // older reviews never send "you were mentioned" (an import of last year stays quiet)
export const MAX_ITEMS = 5000;

export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------------------------------------------------------------- names

/** Names that go together. A person whose first name is in a group answers to every name in it. */
const NICKNAME_GROUPS = [
  'alexander alexandra alejandro alejandra alexis alex alexa lexi', 'andrew andy drew andres andre', 'andrea andy',
  'anthony tony antonio toni', 'benjamin ben benny benji', 'robert rob robbie bob bobby roberto beto',
  'william will bill billy liam willy guillermo memo', 'michael mike mikey mick mickey miguel',
  'christopher chris topher', 'christina christine kristina cristina chris tina', 'daniel dan danny dani',
  'daniela danielle dani', 'david dave davey', 'edward ed eddie ted', 'eduardo lalo eddie', 'elizabeth liz lizzy lizzie beth betty eliza libby',
  'isabel isabella izzy bella isa', 'francisco frank frankie paco pancho', 'frances francesca fran', 'gabriel gabe',
  'gabriela gabriella gabi gaby', 'james jim jimmy jamie', 'jennifer jen jenny jenn', 'jessica jess jessie',
  'john johnny jack', 'jonathan jon jonny johnny', 'joseph joe joey', 'jose pepe', 'katherine catherine kathryn kate katie kathy cathy kat',
  'margaret maggie meg peggy', 'matthew matt matty mateo', 'nicholas nicolas nick nicky nico', 'patricia pat patty trish tricia',
  'patrick pat', 'rebecca becca becky', 'richard rich rick ricky', 'ricardo ricky rick', 'samuel sam sammy', 'samantha sam sammy',
  'stephanie steph', 'steven stephen steve stevie', 'thomas tom tommy tomas', 'victoria tori torie tory vicky vicki',
  'zachary zach zack', 'timothy tim timmy', 'kenneth ken kenny', 'jeffrey jeff', 'gregory greg', 'raymond ray', 'ronald ron ronnie',
  'donald don donnie', 'lawrence larry', 'jacob jake', 'joshua josh', 'nathaniel nathan nate', 'abigail abby', 'alicia ali allie',
  'allison alison ali allie', 'amanda mandy', 'deborah debbie deb', 'eleanor ellie', 'emily emmy', 'josephine josie',
  'kimberly kim', 'madison maddie maddy', 'melissa mel missy', 'natalie nat', 'olivia liv', 'pamela pam', 'sandra sandy',
  'susan sue suzy susie', 'teresa theresa tess', 'fernando fer nando', 'guadalupe lupe lupita', 'ignacio nacho', 'enrique kike quique',
  'alberto beto', 'humberto beto', 'gonzalo chalo', 'rosario charo chayo', 'dolores lola', 'mercedes meche', 'jesus chuy chucho',
  'manuel manny manolo', 'emmanuel manny', 'santiago santi', 'sebastian sebas', 'maximiliano max maxi', 'maximilian max',
  'luciano lucho', 'lucas luke', 'alessandro sandro', 'macarena maca', 'agustina agus', 'tatiana tati', 'courtney court',
];
const NICKS = new Map();
for (const g of NICKNAME_GROUPS) {
  const names = g.split(' ');
  for (const n of names) { const set = NICKS.get(n) || new Set(); names.forEach((x) => set.add(x)); NICKS.set(n, set); }
}
/** The names a first name goes by ('michael' → mike, mikey…; 'mike' → michael…), itself included. */
export const nicknamesOf = (first) => [...(NICKS.get(fold(first)) || new Set([fold(first)]))];

/** First names that are also everyday words (English and Spanish): they need a cue that they mean a person. */
export const COMMON_WORDS = new Set(('will bill rose rosa grace hope joy faith may june april august summer autumn dawn mark jack frank sue pat rich art max '
  + 'ray sky amber ruby jade olive sage chip penny candy honey brandy sherry ginger crystal page gene dean drew rob sunny star river rocky '
  + 'buck chase hunter cash lane miles wade dash norm guy sonny chance lucky love merry sandy cliff glen heath forest reed carol lily iris '
  + 'ivy holly daisy violet poppy fern hazel heather coral pearl christian harmony melody destiny trinity mercy liberty duke prince earl '
  + 'major sterling price dot bee kat ever wilder al flor paz luz sol rocio pilar consuelo amparo cruz blanca esperanza gloria soledad '
  + 'angeles nieves angel jesus nacho vale ale don tess mel liv nat tim ken ted ed joe bob nick court sam bella lola').split(' '));

/** Words that are never names here, whatever the team is called. */
const NEVER = new Set(('the a an and or but our we us you they he she it i me my your their this that these those there here was were is are be been '
  + 'had has have do did not no yes so very really great good amazing awesome wonderful excellent best food service server staff place '
  + 'el la los las un una y o pero muy bien bueno buena excelente servicio comida mesero mesera').split(' '));

// Cues that the word next to them is a person.
const ROLE = 'server servers waiter waitress bartender bartenders barman host hostess manager chef busser runner sommelier somm captain '
  + 'mixologist barista bartendress mesero mesera meseros cantinero cantinera gerente anfitrion anfitriona';
const STRONG_BEFORE = new Set(`${ROLE} our thanks thank kudos shoutout shout ask asked request requested named called gracias nuestro nuestra atendio atendidos`.split(' '));
const WEAK_BEFORE = new Set('by to from with and for con por para y'.split(' '));
// Right after it: a verb only a person does ("Will took care of us"), or "was"/"is" (a person unless the sentence is about a drink).
const AFTER = new Set(('took made recommended helped knew went gave explained suggested checked kept remembered served waited poured '
  + 'brought treated welcomed greeted handled takes makes knows always truly really nos atendio recomendo hizo').split(' '));
const BE = new Set('was is were fue es estuvo'.split(' '));
// Words that make an everyday-word "name" a thing: right before it…
const NOT_BEFORE = new Set('the a an of some this that glass bottle bottles carafe sparkling dry frozen pink house la el una un de del unos unas copa botella'.split(' '));
// …right after it (Will be back, Will definitely return, Will recommend)…
const NOT_AFTER = new Set(('be definitely never not always come return go recommend have try visit dine surely certainly probably again back '
  + 'wine wines sangria spritz pairing ever too also').split(' '));
// …or nearby, when nothing says it's a person (a crisp Rose, a Rose pairing).
const THING = new Set(('wine wines glass bottle pour crisp dry sparkling pairing paired sangria cocktail sip vino copa botella cheese sauce garnish '
  + 'flavor flavour tasted tastes refreshing fruity chilled vintage frozen spritz fizz brut').split(' '));
const TITLES = new Set(['chef', 'dr', 'mr', 'mrs', 'ms', 'miss', 'sr', 'sra', 'srta', 'don', 'dona']);

/** The restaurant's own words that are never names: its name, rooms and areas, and the manager's ignore list. */
export function ignoredWords(settings = {}, extra = []) {
  const out = new Set();
  const add = (s) => { for (const w of fold(s).split(/[^a-z0-9]+/)) if (w.length > 1) out.add(w); };
  add(settings.restaurantName || '');
  for (const r of [...(settings.rooms || []), ...(settings.areas || [])]) add(r);
  for (const w of extra) add(w);
  return out;
}

const wordsOf = (text) => fold(text).replace(/[^a-z0-9' -]+/g, ' ').split(/[\s-]+/).filter(Boolean);
const dropTitles = (ws) => { const out = [...ws]; while (out.length > 1 && TITLES.has(out[0])) out.shift(); return out; };

/**
 * Every name a person answers to, in one place: { first, last, lastInitial, names: [{ text, kind }] } with kind
 * 'first' (the common first name), 'full' (a two-word common name: "Mary Ann"), 'nickname' (Michael → Mike…),
 * 'aka' (a manager's "also known as"), 'legal' (the legal first name, and legal first + last) when the
 * profile has them (user.legalFirstName / user.legalLastName). When core gets aliasesOf(user), this is the
 * one function to switch over.
 */
export function namesOf(u) {
  const common = dropTitles(wordsOf(u?.name));
  if (!common.length) return { first: '', last: '', lastInitial: '', names: [] };
  const first = common[0];
  const legalFirst = wordsOf(u.legalFirstName)[0] || '';
  const legalLast = wordsOf(u.legalLastName).join(' ');
  const rest = common.slice(1);
  const last = rest.join(' ') || legalLast;
  const out = [];
  const add = (text, kind) => {
    const ws = wordsOf(text);
    const t = ws.join(' ');
    if (!ws.length || ws.join('').length < 2 || (ws.length === 1 && NEVER.has(ws[0])) || out.some((n) => n.text === t)) return;
    out.push({ text: t, kind });
  };
  add(first, 'first');
  if (rest.length && rest.join('').length > 1) add(common.join(' '), 'full');
  for (const nick of nicknamesOf(first)) add(nick, 'nickname');
  for (const a of Array.isArray(u.aka) ? u.aka : []) add(a, 'aka');
  if (legalFirst) {
    add(legalFirst, 'legal');
    for (const nick of nicknamesOf(legalFirst)) add(nick, 'nickname');
    if (legalLast) add(`${legalFirst} ${legalLast}`, 'legal');
  }
  for (const a of aliasesOf(u)) add(dropTitles(wordsOf(a)).join(' '), 'legal'); // core/names.js: every name the person answers to
  return { first, last, lastInitial: last ? last.split(' ').at(-1)[0] : '', names: out };
}

/**
 * The team, ready for matching: { people: Map(id → person), index: Map(word → [{ userId, kind }]),
 * phrases: Map(first word → [{ words, userId, kind }]), ignore: Set }.
 */
export function buildRoster(users, { ignore = new Set() } = {}) {
  const people = new Map();
  const index = new Map();
  const phrases = new Map();
  for (const u of users) {
    if (!u?.id || !u.name) continue;
    if (u.role === 'events' && u.onSchedule !== true) continue; // the shared events-team account isn't a person
    const n = namesOf(u);
    if (!n.first) continue;
    people.set(u.id, { id: u.id, name: u.name, first: n.first, last: n.last, lastInitial: n.lastInitial, active: u.active !== false, names: n.names });
    for (const { text, kind } of n.names) {
      const ws = text.split(' ');
      if (ws.length === 1) { const l = index.get(ws[0]) || []; if (!l.some((e) => e.userId === u.id)) l.push({ userId: u.id, kind }); index.set(ws[0], l); }
      else { const l = phrases.get(ws[0]) || []; l.push({ words: ws, userId: u.id, kind }); phrases.set(ws[0], l); }
    }
  }
  return { people, index, phrases, ignore };
}

// ---------------------------------------------------------------- reading text

const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’]*/gu;
/** Words with their place in the text: { raw, norm, start, end, poss, sentenceStart, sentenceEnd, gapBefore }. */
export function tokenize(text) {
  const src = String(text ?? '');
  const toks = [];
  for (const m of src.matchAll(WORD_RE)) {
    let raw = m[0];
    let poss = false;
    if (/['’]s$/i.test(raw)) { raw = raw.slice(0, -2); poss = true; } else raw = raw.replace(/['’]+$/, '');
    if (!raw) continue;
    toks.push({ raw, norm: fold(raw), start: m.index, end: m.index + raw.length, rawEnd: m.index + m[0].length, poss });
  }
  for (let i = 0; i < toks.length; i++) {
    const gap = src.slice(i ? toks[i - 1].rawEnd : 0, toks[i].start);
    toks[i].gapBefore = gap;
    toks[i].sentenceStart = i === 0 || /[.!?\n¡¿]/.test(gap);
    const after = src.slice(toks[i].rawEnd, i + 1 < toks.length ? toks[i + 1].start : src.length);
    toks[i].sentenceEnd = i + 1 === toks.length || /[.!?\n]/.test(after);
  }
  return toks;
}
const isUpper = (c) => c && c !== c.toLowerCase() && c === c.toUpperCase();
/** Mostly capitals (a host's "REQ SARAH" note): capital letters say nothing there. */
const shouting = (text) => { const letters = String(text).replace(/[^\p{L}]/gu, ''); return letters.length >= 6 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.8; };

/**
 * How sure we are an everyday word is a person here: 'strong' (a cue says so), 'weak' (capitalized in the
 * middle of a sentence, nothing against it: it counts only if they worked that day) or false.
 */
function personCue(toks, i, { caps }) {
  const t = toks[i];
  const prev = toks[i - 1];
  const next = toks[i + 1];
  const capital = caps ? true : isUpper(t.raw[0]) && t.raw !== t.raw.toUpperCase();
  if (!capital) return false; // "will", "rose", "ever" in lower case are words
  if (prev && !t.sentenceStart && NOT_BEFORE.has(prev.norm)) return false;
  if (next && !t.sentenceEnd && NOT_AFTER.has(next.norm)) return false;
  const before = [];
  for (let k = i - 1; k >= 0 && k >= i - 3; k--) { before.push(toks[k].norm); if (toks[k].sentenceStart) break; }
  const thing = () => { for (let k = Math.max(0, i - 4); k <= Math.min(toks.length - 1, i + 4); k++) if (THING.has(toks[k].norm)) return true; return false; };
  const strong = (!t.sentenceStart && before.some((w) => STRONG_BEFORE.has(w)))
    || (next && !t.sentenceEnd && (AFTER.has(next.norm) || (/,/.test(next.gapBefore) && ['our', 'nuestro', 'nuestra', 'the'].includes(next.norm)) || STRONG_BEFORE.has(next.norm)))
    || t.poss;
  if (strong) return 'strong';
  if (next && !t.sentenceEnd && BE.has(next.norm)) return thing() ? false : 'strong'; // "Rose was amazing" yes, "Rose was crisp and dry" no
  if (t.sentenceStart || t.sentenceEnd) return false; // "Best night Ever!" / a capital that starts a sentence
  if (thing()) return false;
  return 'weak'; // capitalized mid-sentence ("we loved Ever"): counts only if they worked that day, and waits for a manager
}

/** The person (or people) a run of words starting at token i names: { candidates, kind, length } or null. */
function lookup(roster, toks, i) {
  const t = toks[i];
  if (!t || t.norm.length < 2 || NEVER.has(t.norm) || roster.ignore.has(t.norm)) return null;
  let best = null;
  for (const ph of roster.phrases.get(t.norm) || []) {
    if (ph.words.every((w, k) => toks[i + k]?.norm === w)) {
      if (!best || ph.words.length > best.length) best = { length: ph.words.length, entries: [ph] };
      else if (ph.words.length === best.length) best.entries.push(ph);
    }
  }
  if (best) return { candidates: [...new Set(best.entries.map((e) => e.userId))], kind: best.entries[0].kind, length: best.length };
  const entries = roster.index.get(t.norm);
  if (!entries?.length) return null;
  const exact = entries.filter((e) => e.kind === 'first' || e.kind === 'aka' || e.kind === 'legal');
  return { candidates: [...new Set(entries.map((e) => e.userId))], kind: (exact[0] || entries[0]).kind, length: 1, exact: exact.map((e) => e.userId) };
}

/** "Alex D." or "Alex Diaz": the next word narrows several people down to one. */
function byLastName(roster, candidates, next) {
  if (!next || candidates.length < 2) return null;
  const hits = candidates.filter((id) => {
    const p = roster.people.get(id);
    return p && p.last && (next.norm === p.last || next.norm === p.last.split(' ')[0] || (next.norm.length === 1 && next.norm === p.lastInitial));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Staff names in a review. ctx: { worked(userId) → true|false|null for the dining date }.
 * Returns hits: [{ key, norm, token, spans: [[start, end]], candidates: [userId], kind, cue }].
 * One hit per name per review (every place it's written is a span); "Alex D." and "Alex M." are two.
 */
export function findMentions(text, roster, ctx = {}) {
  const toks = tokenize(text);
  const caps = shouting(text);
  const out = new Map();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const found = lookup(roster, toks, i);
    if (!found) continue;
    let cue = 'name';
    if (found.length === 1 && COMMON_WORDS.has(t.norm)) {
      if (/[À-ɏ]/.test(t.raw) && t.raw.toLowerCase() !== t.norm) continue; // "Rosé" is the wine
      cue = personCue(toks, i, { caps });
      if (!cue) continue;
      if (cue === 'weak' && !found.candidates.some((id) => ctx.worked?.(id) === true)) continue;
    }
    let candidates = found.candidates;
    const next = toks[i + found.length];
    const last = byLastName(roster, candidates, next);
    if (last) candidates = [last];
    const end = (last && next ? next : toks[i + found.length - 1]).end; // "Alex D" marked whole
    const key = `${found.length > 1 ? toks.slice(i, i + found.length).map((x) => x.norm).join(' ') : t.norm}${last ? `:${last}` : ''}`;
    const hit = out.get(key) || { key, norm: t.norm, token: text.slice(t.start, end), spans: [], candidates, kind: last ? 'lastName' : found.kind, cue, exact: found.exact || [] };
    hit.spans.push([t.start, end]);
    if (cue === 'strong' || cue === 'name') hit.cue = hit.cue === 'weak' ? cue : hit.cue;
    out.set(key, hit);
    i += found.length - 1;
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- reservation requests

const NAME = String.raw`([\p{L}][\p{L}\p{M}'’-]*(?:\s+[\p{L}][\p{L}\p{M}'’-]*)?)`;
const STAFF = String.raw`(?:server|waiter|waitress|bartender|host)`;
// Each finds a name the guest asked for. Case doesn't matter here: the request itself is the cue.
export const REQUEST_PATTERNS = [
  String.raw`\b(?:request(?:s|ed|ing)?|req)\b\.?\s*[:\-–]?\s*(?:${STAFF}\s+)?(?:for\s+)?${NAME}`,
  String.raw`\bask(?:s|ed|ing)?\s+for\s+(?:${STAFF}\s+)?${NAME}`,
  String.raw`\b(?:sit|seat|seated|sat|put|place)\s+(?:us\s+|them\s+|him\s+|her\s+)?(?:in|at|with)\s+${NAME}`,
  String.raw`\b(?:would\s+(?:like|love)|wants?|wanted|prefers?|preferred|hoping\s+for|loves?)\s+${NAME}\s+(?:as\s+(?:our|their|the|his|her)\s+|to\s+(?:be\s+)?(?:our|their|his|her)\s+)?${STAFF}\b`,
  String.raw`\b${STAFF}\s*(?:request(?:ed)?\s*)?[:\-–]\s*${NAME}`,
  String.raw`\b${STAFF}\s+${NAME}\s+(?:please|pls|if\s+possible|requested|again)\b`,
  String.raw`\bwith\s+${NAME}\s+(?:again|if\s+possible|please)\b`,
  String.raw`\b(?:pide|piden|pidi[oó]|pidieron|solicita|solicitan|solicit[oó]|quiere|quieren)\s+(?:a\s+|al\s+|que\s+(?:los|las|le|les)\s+atienda\s+)?(?:(?:mesero|mesera|cantinero|cantinera|bartender)\s+)?${NAME}`,
  String.raw`\b(?:secci[oó]n|zona|estaci[oó]n|mesas?)\s+de\s+${NAME}`,
  String.raw`\bcon\s+${NAME}\s+(?:de|como)\s+(?:mesero|mesera|cantinero|cantinera|bartender)`,
  String.raw`\b(?:mesero|mesera|cantinero|cantinera)\s*[:\-–]\s*${NAME}`,
  String.raw`\bque\s+(?:los|las|nos|le|les)\s+atienda\s+${NAME}`,
].map((p) => new RegExp(p, 'giu'));
// "Sarah's section": the name comes first.
const SECTION_RE = /([\p{L}][\p{L}\p{M}-]*)['’]s\s+(?:section|station|tables?|area|side)\b/giu;
const FILLER = new Set('a an the for to us them me please pls if possible again section table booth window patio bar our server servers same one any'.split(' '));

/** Resolve the words captured at [start, …) to a person: a hit like findMentions', or null. */
function nameAt(text, start, capture, roster) {
  const toks = tokenize(capture).map((t) => ({ ...t, start: t.start + start, end: t.end + start }));
  if (!toks.length || FILLER.has(toks[0].norm)) return null;
  const found = lookup(roster, toks, 0);
  if (!found) return null;
  let candidates = found.candidates;
  const last = byLastName(roster, candidates, toks[found.length]);
  if (last) candidates = [last];
  const end = (last && toks[found.length] ? toks[found.length] : toks[found.length - 1]).end;
  return { key: `${toks.slice(0, found.length).map((x) => x.norm).join(' ')}${last ? `:${last}` : ''}`, norm: toks[0].norm, token: text.slice(toks[0].start, end),
    spans: [[toks[0].start, end]], candidates, kind: last ? 'lastName' : found.kind, cue: 'request', exact: found.exact || [] };
}

/** Guests asking for someone in a reservation's notes ("request Sarah", "sit in Mike's section", "pide a Flor"). */
export function findRequests(text, roster) {
  const src = String(text ?? '');
  const out = new Map();
  const take = (hit) => { if (!hit) return; const cur = out.get(hit.key); if (cur) cur.spans.push(...hit.spans.filter((s) => !cur.spans.some((c) => c[0] === s[0]))); else out.set(hit.key, hit); };
  for (const re of [...REQUEST_PATTERNS, SECTION_RE]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const cap = m[1];
      const at = m.index + m[0].indexOf(cap);
      take(nameAt(src, at, cap.replace(/['’]s$/i, ''), roster));
    }
  }
  return [...out.values()];
}

/** A requested-server field ("Sarah", "Sarah K."): the whole field is the name. */
export function findRequestedServer(text, roster) {
  const src = String(text ?? '').trim();
  if (!src) return [];
  const hit = nameAt(src, 0, src, roster);
  return hit ? [{ ...hit, cue: 'field' }] : [];
}

/**
 * Who a hit is: { userId, status: 'confirmed' | 'needsReview', reason, candidates }.
 * ctx: { worked(userId) → true|false|null, dayHasData, serverId }.
 */
export function resolveHit(hit, ctx = {}) {
  const c = hit.candidates;
  const worked = (id) => ctx.worked?.(id) ?? null;
  if (c.length > 1) {
    if (ctx.serverId && c.includes(ctx.serverId)) return { userId: ctx.serverId, status: 'confirmed', reason: 'server', candidates: c };
    const w = c.filter((id) => worked(id) === true);
    if (w.length === 1) return { userId: w[0], status: 'confirmed', reason: 'workedThatDay', candidates: c };
    const order = [...c].sort((a, b) => (worked(b) === true) - (worked(a) === true) || hit.exact.includes(b) - hit.exact.includes(a));
    return { userId: null, status: 'needsReview', reason: 'ambiguous', candidates: order };
  }
  const id = c[0];
  if (hit.cue === 'weak') return { userId: id, status: 'needsReview', reason: 'commonWord', candidates: c };
  if (ctx.dayHasData && worked(id) === false) return { userId: id, status: 'needsReview', reason: 'notOnShift', candidates: c };
  return { userId: id, status: 'confirmed', reason: hit.kind === 'lastName' ? 'lastName' : hit.kind, candidates: c };
}

/** Who worked on these dates (a published shift or a clock-in). worked(id, date) is null when the day has no data at all. */
export function workIndex(store, dates) {
  const want = new Set([...dates].filter(Boolean));
  const by = new Map();
  const touch = (d) => { let x = by.get(d); if (!x) by.set(d, x = { ids: new Set(), any: false }); return x; };
  if (want.size) {
    store.list('shifts', (s) => { if (want.has(s.date)) { const x = touch(s.date); x.any = true; if (s.userId && s.published) x.ids.add(s.userId); } return false; });
    store.list('timeEntries', (t) => { if (want.has(t.date)) { const x = touch(t.date); x.any = true; if (t.userId) x.ids.add(t.userId); } return false; });
  }
  return { worked: (id, date) => { const x = by.get(date); return x?.any ? x.ids.has(id) : null; }, has: (date) => !!by.get(date)?.any };
}

// ---------------------------------------------------------------- periods

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The same date a year earlier (Feb 29 → Feb 28). */
export function yearBefore(date) {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
/**
 * The dates a report covers. args: { period: 'season' | 'month' | 'range', seasonId, month: 'YYYY-MM', from, to }.
 * Default: the season today is in. Returns { kind, from, to, label, seasonId?, month?, prev: { from, to } }.
 */
export function periodRange(args = {}, { settings, today, lang = 'en', fail }) {
  const bad = (m) => (fail ? fail(400, m) : (() => { throw new Error(m); })());
  let out;
  if (args.period === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(String(args.month || ''));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) bad('Pick a month');
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    out = { kind: 'month', month: args.month, from: `${args.month}-01`, to: `${args.month}-${String(last).padStart(2, '0')}` };
  } else if (args.period === 'range') {
    if (!DAY.test(args.from || '') || !DAY.test(args.to || '') || args.from > args.to) bad('Pick a start and an end date');
    if (args.to > addDays(args.from, 366 * 3)) bad('Pick at most 3 years');
    out = { kind: 'range', from: args.from, to: args.to };
  } else {
    const s = (args.seasonId && seasonById(args.seasonId, settings, lang)) || seasonOf(today, settings, lang);
    out = { kind: 'season', seasonId: s.id, from: s.start, to: s.end, label: s.label };
  }
  return { ...out, prev: { from: yearBefore(out.from), to: yearBefore(out.to) } };
}

// ---------------------------------------------------------------- the store side

export function integration(store) {
  return store.get('integrations', INTEGRATION_ID) || { id: INTEGRATION_ID };
}
export function saveIntegration(store, patch) {
  return store.get('integrations', INTEGRATION_ID) ? store.update('integrations', INTEGRATION_ID, patch) : store.insert('integrations', { id: INTEGRATION_ID, ...patch });
}
export const impactSettings = (store) => { const i = integration(store); return { notify: i.notify !== false, alertLow: i.alertLow !== false, ignoreWords: Array.isArray(i.ignoreWords) ? i.ignoreWords : [] }; };

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const reviewDocId = (source, key) => `rev_${source}_${String(key).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;
const mentionId = (kind, sourceId, field, key) => `imn_${hashKey(`${kind}|${sourceId}|${field}|${key}`)}`;
/** The date a mention counts on: the dining date when the review has one, else when it was posted. */
const reviewDay = (r) => r.diningDate || r.date;
/** The words around a span, and the span's place in them: { text, span }. */
const around = (body, [s, e], pad = 40) => {
  const a = Math.max(0, s - pad);
  const b = Math.min(body.length, e + pad);
  const lead = a > 0 ? '…' : '';
  return { text: `${lead}${body.slice(a, b)}${b < body.length ? '…' : ''}`, span: [s - a + lead.length, e - a + lead.length] };
};
const snippet = (body, [s, e], pad = 60) => {
  const a = Math.max(0, s - pad);
  const b = Math.min(body.length, e + pad);
  return `${a > 0 ? '…' : ''}${body.slice(a, b).replace(/\s+/g, ' ').trim()}${b < body.length ? '…' : ''}`;
};

/** Reviews from a browser or a sync, checked: nothing but the fields kept, texts scrubbed, names shortened. */
export function cleanReviewItems(list, { source, fail }) {
  if (!Array.isArray(list) || !list.length) fail(400, 'There are no reviews to import in that file');
  if (list.length > MAX_ITEMS) fail(400, 'That file is too big. Import a few months at a time.');
  const out = [];
  for (const r of list) {
    if (!r || !DAY.test(r.date || '')) continue;
    const rating = Number(r.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) continue;
    const stars = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.min(5, Math.max(0, Number(v))));
    const t = scrub(r.text, 4000);
    const src = REVIEW_SOURCES.includes(r.source) ? r.source : source;
    const key = /^[ih]_[A-Za-z0-9_-]{1,48}$/.test(String(r.key || '')) ? r.key : `h_${hashKey(`${r.date}|${fold(t).slice(0, 300)}|${rating}`)}`;
    out.push({
      key, source: src, externalId: cleanId(r.externalId), date: r.date, diningDate: DAY.test(r.diningDate || '') ? r.diningDate : '',
      rating: Math.round(rating * 10) / 10, food: stars(r.food), service: stars(r.service), ambience: stars(r.ambience), value: stars(r.value),
      text: t, reviewer: shortName(r.reviewer), server: text(scrub(r.server, 60), 60),
    });
  }
  if (!out.length) fail(400, 'There are no reviews to import in that file');
  return out;
}

/**
 * The positive-impact logic, bound to one store: impact.* methods on `api`, and the scanning the
 * OpenTable import and sync use. Plugged into core/service.js like core/tripleseat.js.
 */
export function impactLinks({ store, api, fail, needAuth, needMgr, needAdmin, notify, now, settings, langOf, onReview = [] }) {
  const at = () => now().toISOString();
  const today = () => todayStr(now());
  const isMgr = (a) => canManageSchedule(a);
  let roster = null; // built once per request (names don't change mid-request, except setAka, which resets it)
  const team = () => (roster ||= buildRoster(store.list('users'), { ignore: ignoredWords(settings(), impactSettings(store).ignoreWords) }));
  const nameOf = (id) => store.get('users', id)?.name || '';

  /** "You were mentioned in a 5-star review!" once, to the person, when a confirmed match is fresh and notifications are on. */
  function maybeNotify(m, review) {
    if (m.kind !== 'review' || m.status !== 'confirmed' || !m.userId || m.notifiedAt || !review || review.rating < 5) return m;
    if (!impactSettings(store).notify || review.date < addDays(today(), -NOTIFY_WITHIN_DAYS)) return m;
    const u = store.get('users', m.userId);
    if (!u || u.active === false) return m;
    const quote = m.spans?.[0] ? snippet(review.text, m.spans[0], 50) : '';
    notify([u.id], {
      en: `You were mentioned in a 5-star review!${quote ? ` “${quote}”` : ''}`,
      es: `¡Te mencionaron en una reseña de 5 estrellas!${quote ? ` “${quote}”` : ''}`,
    }, '#/kudos');
    return store.update('impactMentions', m.id, { notifiedAt: at() });
  }

  /** Write a source's hits: new ones resolved, a manager's decisions kept, names no longer there removed. */
  function upsertHits(kind, src, field, hits, ctx, seen) {
    let changed = 0;
    for (const hit of hits) {
      const id = mentionId(kind, src.id, field, hit.key);
      seen.add(id);
      const cur = store.get('impactMentions', id);
      const base = { kind, sourceId: src.id, source: kind === 'review' ? src.source : 'opentable', field, date: kind === 'review' ? reviewDay(src) : src.date,
        rating: kind === 'review' ? src.rating : null, token: hit.token, key: hit.key, spans: hit.spans.slice(0, 10) };
      if (cur?.decidedBy) { // a manager's decision stands; the text may have moved
        if (JSON.stringify(cur.spans) !== JSON.stringify(base.spans) || cur.date !== base.date || cur.rating !== base.rating) { store.update('impactMentions', id, base); changed++; }
        continue;
      }
      const r = resolveHit(hit, ctx);
      const doc = { ...base, userId: r.userId, candidates: r.candidates.slice(0, 8), status: r.status, reason: r.reason, auto: true };
      if (!cur) { const m = store.insert('impactMentions', { id, ...doc, createdAt: at() }); if (kind === 'review') maybeNotify(m, src); changed++; continue; }
      const same = ['userId', 'status', 'reason', 'date', 'rating'].every((k) => cur[k] === doc[k]) && JSON.stringify(cur.spans) === JSON.stringify(doc.spans) && JSON.stringify(cur.candidates) === JSON.stringify(doc.candidates);
      if (!same) { const m = store.update('impactMentions', id, doc); if (kind === 'review') maybeNotify(m, src); changed++; }
    }
    return changed;
  }

  /** Match one review's text (or one reservation's notes) against the team. work: workIndex for its date. */
  function scanReview(review, work) {
    const day = reviewDay(review);
    const server = review.server ? lookupServer(review.server) : null;
    const ctx = { worked: (id) => work.worked(id, day), dayHasData: work.has(day), serverId: server };
    const seen = new Set();
    let changed = upsertHits('review', review, 'text', findMentions(review.text, team(), ctx), ctx, seen);
    changed += dropStale('review', review.id, seen);
    return changed;
  }
  function scanReservation(res, work) {
    // A guest asking for someone counts whether or not they're on that day (it may not be scheduled yet);
    // who worked only settles which of two people with the name it is.
    const ctx = { worked: (id) => work.worked(id, res.date), dayHasData: false };
    const seen = new Set();
    let changed = upsertHits('request', res, 'notes', findRequests(res.notes, team()), ctx, seen);
    changed += upsertHits('request', res, 'requestedServer', findRequestedServer(res.requestedServer, team()), ctx, seen);
    changed += dropStale('request', res.id, seen);
    return changed;
  }
  function dropStale(kind, sourceId, seen) {
    let n = 0;
    for (const m of store.list('impactMentions', (x) => x.sourceId === sourceId && x.kind === kind && !seen.has(x.id) && !x.decidedBy)) { store.remove('impactMentions', m.id); n++; }
    return n;
  }
  /** OpenTable's server on a review ("Alex D"), as a person, when it names exactly one. */
  function lookupServer(name) {
    const hits = findRequestedServer(name, team());
    return hits.length === 1 && hits[0].candidates.length === 1 ? hits[0].candidates[0] : null;
  }
  /** Scan many sources: reviews and reservations (docs), with one work index for all their dates. */
  function scanMany({ reviews = [], reservations = [] }) {
    const work = workIndex(store, [...reviews.map(reviewDay), ...reservations.map((r) => r.date)]);
    const had = new Set();
    if (reservations.length) store.list('impactMentions', (m) => { if (m.kind === 'request') had.add(m.sourceId); return false; });
    let changed = 0;
    for (const r of reviews) changed += scanReview(r, work);
    for (const r of reservations) if (r.notes || r.requestedServer || had.has(r.id)) changed += scanReservation(r, work);
    return changed;
  }

  // ---------- reviews: plan (preview) and apply, for any source ----------
  function planReviews(items) {
    const bySource = new Map();
    const printOf = (source) => {
      if (!bySource.has(source)) { const m = new Map(); store.list('guestReviews', (r) => { if (r.source === source && r.print) m.set(r.print, r.id); return false; }); bySource.set(source, m); }
      return bySource.get(source);
    };
    const counts = { new: 0, updated: 0, same: 0, duplicate: 0, fiveStar: 0 };
    const rows = [];
    const keys = new Set();
    for (const it of items) {
      let id = reviewDocId(it.source, it.key);
      const print = reviewPrint(it);
      if (!store.get('guestReviews', id)) { const other = printOf(it.source).get(print); if (other) id = other; } // the same review under another key (a file, then the API)
      if (keys.has(id)) { counts.duplicate++; rows.push({ ...it, id, status: 'duplicate' }); continue; }
      keys.add(id);
      const cur = store.get('guestReviews', id);
      const fields = ['date', 'diningDate', 'rating', 'food', 'service', 'ambience', 'value', 'text', 'reviewer', 'server'];
      const status = !cur ? 'new' : fields.every((k) => (cur[k] ?? null) === (it[k] ?? null)) ? 'same' : 'updated';
      counts[status]++;
      if (it.rating >= 5) counts.fiveStar++;
      rows.push({ ...it, id, print, status });
    }
    return { rows, counts, dates: [...new Set(items.map((r) => r.date))].sort() };
  }

  /** Save reviews (new and changed only) and match their names. meta: { origin: 'csv' | 'api', importId }. */
  function applyReviews(list, { origin = 'csv', importId = null } = {}) {
    roster = null;
    // Cleaned here too, whoever calls (a connector, a sync, the import): scrubbed text, shortened names.
    const items = list.length ? cleanReviewItems(list, { source: REVIEW_SOURCES.includes(list[0]?.source) ? list[0].source : 'other', fail }) : [];
    const plan = planReviews(items);
    const touched = [];
    const fresh = [];
    for (const r of plan.rows) {
      if (r.status === 'same' || r.status === 'duplicate') continue;
      const { status, row, key, ...doc } = r;
      const cur = store.get('guestReviews', r.id);
      const saved = cur ? store.update('guestReviews', r.id, { ...doc, origin, importId: cur.importId || importId, updatedAt: at() })
        : store.insert('guestReviews', { ...doc, key, origin, importId, replied: false, reply: '', createdAt: at() });
      touched.push(saved);
      if (!cur) fresh.push(saved);
    }
    const mentions = scanMany({ reviews: touched });
    for (const r of fresh) reviewArrived(r);
    return { counts: plan.counts, mentions, from: plan.dates[0] || null, to: plan.dates.at(-1) || null };
  }

  /**
   * The hook for a review that just arrived (any source): managers hear about a recent low rating, and
   * anything registered in onReview (a later AI-reply drafter, a Slack alert…) gets the review and its matches.
   */
  function reviewArrived(review) {
    const mentions = store.list('impactMentions', (m) => m.sourceId === review.id && m.kind === 'review');
    const recent = review.date >= addDays(today(), -NOTIFY_WITHIN_DAYS);
    if (recent && review.rating <= LOW_RATING && impactSettings(store).alertLow) {
      const ids = store.list('users').filter((u) => u.active !== false && canManageSchedule(u)).map((u) => u.id);
      const src = review.source === 'opentable' ? 'OpenTable' : review.source[0].toUpperCase() + review.source.slice(1);
      const quote = review.text ? ` “${review.text.slice(0, 90)}${review.text.length > 90 ? '…' : ''}”` : '';
      notify(ids, { en: `New ${review.rating}-star review on ${src}.${quote}`, es: `Nueva reseña de ${review.rating} estrellas en ${src}.${quote}` }, '#/impact/reviews');
    }
    for (const fn of onReview) { try { fn({ review, mentions, store }); } catch (e) { console.error('Review hook failed:', e.message); } }
  }

  /** What an import would find, without saving: counts, and the names it would match. */
  function previewReviews(items) {
    roster = null;
    const plan = planReviews(items);
    const work = workIndex(store, plan.rows.map(reviewDay));
    const found = new Map();
    let needsReview = 0;
    for (const r of plan.rows) {
      if (r.status === 'duplicate') continue;
      const day = reviewDay(r);
      const ctx = { worked: (id) => work.worked(id, day), dayHasData: work.has(day), serverId: r.server ? lookupServer(r.server) : null };
      for (const h of findMentions(r.text, team(), ctx)) {
        const x = resolveHit(h, ctx);
        if (x.status !== 'confirmed') { needsReview++; continue; }
        const e = found.get(x.userId) || { userId: x.userId, name: nameOf(x.userId), mentions: 0, fiveStar: 0 };
        e.mentions++; if (r.rating >= 5) e.fiveStar++;
        found.set(x.userId, e);
      }
    }
    return { counts: plan.counts, dates: plan.dates, people: [...found.values()].sort((a, b) => b.mentions - a.mentions), needsReview,
      rows: plan.rows.slice(0, 200).map((r) => ({ row: r.row, date: r.date, diningDate: r.diningDate, rating: r.rating, reviewer: r.reviewer, text: r.text.slice(0, 160), status: r.status })) };
  }

  // ---------- the report ----------
  const reservationOf = (id) => store.get('otReservations', id);
  /** Confirmed credit per person between two dates (mentions by rating, requests, kudos). */
  function tally(from, to) {
    const per = new Map();
    const row = (id) => { let r = per.get(id); if (!r) per.set(id, r = { userId: id, fiveStar: new Set(), reviews: new Set(), byRating: { 5: new Set(), 4: new Set(), 3: new Set(), 2: new Set(), 1: new Set() }, requests: new Set(), kudos: 0 }); return r; };
    const cancelled = new Map();
    for (const m of store.list('impactMentions', (x) => x.status === 'confirmed' && x.userId && x.date >= from && x.date <= to)) {
      const r = row(m.userId);
      if (m.kind === 'review') {
        r.reviews.add(m.sourceId);
        const stars = Math.max(1, Math.min(5, Math.round(m.rating || 0)));
        r.byRating[stars].add(m.sourceId);
        if (m.rating >= 5) r.fiveStar.add(m.sourceId);
      } else {
        if (!cancelled.has(m.sourceId)) cancelled.set(m.sourceId, ['cancelled'].includes(reservationOf(m.sourceId)?.status));
        if (!cancelled.get(m.sourceId)) r.requests.add(m.sourceId);
      }
    }
    for (const k of store.list('kudos', (x) => x.userId && x.date >= from && x.date <= to)) row(k.userId).kudos++;
    const out = new Map();
    for (const [id, r] of per) {
      const byRating = Object.fromEntries(Object.entries(r.byRating).map(([s, set]) => [s, set.size]));
      const x = { userId: id, fiveStar: r.fiveStar.size, mentions: r.reviews.size, byRating, requests: r.requests.size, kudos: r.kudos };
      x.score = x.fiveStar + x.requests + x.kudos;
      if (x.mentions || x.requests || x.kudos) out.set(id, x);
    }
    return out;
  }
  function seasonsList(lang) {
    let first = today();
    const earliest = (col, f) => store.list(col, (x) => { const d = f(x); if (d && d < first) first = d; return false; });
    earliest('guestReviews', reviewDay); earliest('kudos', (k) => k.date); earliest('impactMentions', (m) => m.date);
    if (first < addDays(today(), -366 * 4)) first = addDays(today(), -366 * 4);
    return seasonsBetween(first, today(), settings(), lang).slice(0, 10).map((s) => ({ id: s.id, label: s.label, from: s.start, to: s.end }));
  }
  const userSummary = (id) => { const u = store.get('users', id); return u ? { id: u.id, name: u.name, active: u.active !== false, color: u.color || '', photoId: u.photoId || null } : { id, name: '', active: false }; };

  /** One person's credit in a period, with the reviews, requests and kudos behind it. self: only what they may see. */
  function itemsFor(userId, range, { self }) {
    const items = [];
    const mine = store.list('impactMentions', (m) => m.userId === userId && m.date >= range.from && m.date <= range.to && (self ? m.status === 'confirmed' : m.status !== 'dismissed'));
    const bySource = new Map();
    for (const m of mine) { const l = bySource.get(m.sourceId) || []; l.push(m); bySource.set(m.sourceId, l); }
    for (const [sourceId, ms] of bySource) {
      const m0 = ms[0];
      const spans = ms.flatMap((m) => m.spans || []);
      const mentions = self ? undefined : ms.map((m) => ({ id: m.id, status: m.status, reason: m.reason, auto: !!m.auto, field: m.field, candidates: m.candidates || [] }));
      if (m0.kind === 'review') {
        const r = store.get('guestReviews', sourceId);
        if (!r) continue;
        items.push({ kind: 'review', id: sourceId, source: r.source, date: reviewDay(r), postedOn: r.date, rating: r.rating, text: r.text, spans,
          ...(self ? {} : { reviewer: r.reviewer, server: r.server, food: r.food, service: r.service, ambience: r.ambience, mentions }) });
      } else {
        const r = reservationOf(sourceId);
        if (!r) continue;
        const noteSpans = ms.filter((m) => m.field === 'notes').flatMap((m) => m.spans || []);
        const field = ms.some((m) => m.field === 'requestedServer');
        // Staff see the words around their name only: the rest of a booking's notes is the guest's business.
        items.push({ kind: 'request', id: sourceId, date: r.date, time: r.time, partySize: r.partySize, status: r.status, requestedServer: field,
          ...(self ? (noteSpans[0] ? (({ text: tx, span }) => ({ text: tx, spans: [span] }))(around(r.notes, noteSpans[0])) : { text: '' }) : { text: r.notes, spans: noteSpans, requestedServerText: r.requestedServer, guest: r.guest, mentions }) });
      }
    }
    for (const k of store.list('kudos', (x) => x.userId === userId && x.date >= range.from && x.date <= range.to)) {
      items.push({ kind: 'kudos', id: k.id, source: k.source, date: k.date, rating: k.stars ?? null, text: k.text, ...(self ? {} : { createdBy: nameOf(k.createdBy) }) });
    }
    return items.sort((a, b) => b.date.localeCompare(a.date));
  }

  const queueView = (m, work) => {
    const src = m.kind === 'review' ? store.get('guestReviews', m.sourceId) : reservationOf(m.sourceId);
    if (!src) return null;
    const day = m.date;
    const textOf = m.kind === 'review' ? src.text : m.field === 'requestedServer' ? src.requestedServer : src.notes;
    return {
      id: m.id, kind: m.kind, source: m.source, date: m.date, rating: m.rating, token: m.token, reason: m.reason, status: m.status, userId: m.userId,
      text: textOf, spans: m.spans || [], field: m.field, reviewer: src.reviewer || src.guest || '', partySize: src.partySize || null,
      candidates: (m.candidates || []).map((id) => ({ ...userSummary(id), worked: work.worked(id, day) })),
    };
  };

  const KUDOS_DATE_MAX = 400; // a shout-out can be added up to about a year after it happened

  Object.assign(api, {
    /** The report: per person, in a season, a month or a date range, with the same dates a year before. Managers. */
    'impact.summary': (actor, args = {}) => {
      needMgr(actor);
      const lang = langOf(actor);
      const range = periodRange(args, { settings: settings(), today: today(), lang, fail });
      const cur = tally(range.from, range.to);
      const prev = tally(range.prev.from, range.prev.to);
      const rows = [...cur.values()].map((x) => ({ ...x, person: userSummary(x.userId), prev: prev.get(x.userId) ? { fiveStar: prev.get(x.userId).fiveStar, requests: prev.get(x.userId).requests, kudos: prev.get(x.userId).kudos, score: prev.get(x.userId).score, mentions: prev.get(x.userId).mentions } : null }))
        .sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.person.name.localeCompare(b.person.name));
      const sum = (m, k) => [...m.values()].reduce((t, x) => t + x[k], 0);
      const reviews = store.list('guestReviews', (r) => reviewDay(r) >= range.from && reviewDay(r) <= range.to);
      const pending = store.list('impactMentions', (m) => m.status === 'needsReview').length;
      return {
        range, seasons: seasonsList(lang), rows, pending,
        totals: {
          reviews: reviews.length, fiveStarReviews: reviews.filter((r) => r.rating >= 5).length,
          fiveStarWithNames: new Set(store.list('impactMentions', (m) => m.kind === 'review' && m.status === 'confirmed' && m.rating >= 5 && m.date >= range.from && m.date <= range.to).map((m) => m.sourceId)).size,
          fiveStar: sum(cur, 'fiveStar'), requests: sum(cur, 'requests'), kudos: sum(cur, 'kudos'), people: cur.size,
          prev: { fiveStar: sum(prev, 'fiveStar'), requests: sum(prev, 'requests'), kudos: sum(prev, 'kudos') },
        },
      };
    },

    /** One person's reviews, requests and kudos. Managers: anyone (userId). Everyone else: themselves only. */
    'impact.get': (actor, args = {}) => {
      needAuth(actor);
      const userId = args.userId || actor.id;
      if (userId !== actor.id && !isMgr(actor)) fail(403, 'You can only see your own kudos');
      if (!store.get('users', userId)) fail(404, 'Person not found');
      const lang = langOf(actor);
      const range = periodRange(args, { settings: settings(), today: today(), lang, fail });
      const self = !isMgr(actor);
      const counts = tally(range.from, range.to).get(userId) || { fiveStar: 0, mentions: 0, byRating: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }, requests: 0, kudos: 0, score: 0 };
      const prev = tally(range.prev.from, range.prev.to).get(userId) || null;
      return { person: userSummary(userId), range, seasons: seasonsList(lang), counts: { ...counts, userId }, prev: prev ? { fiveStar: prev.fiveStar, requests: prev.requests, kudos: prev.kudos, score: prev.score } : null, items: itemsFor(userId, range, { self }) };
    },

    /** Lists for managers. what: 'queue' (matches waiting for a decision), 'kudos' (in a period), 'names' (aka names and settings). */
    'impact.list': (actor, args = {}) => {
      needMgr(actor);
      if (args.what === 'kudos') {
        const range = periodRange(args, { settings: settings(), today: today(), lang: langOf(actor), fail });
        return { range, items: store.list('kudos', (k) => k.date >= range.from && k.date <= range.to).sort((a, b) => b.date.localeCompare(a.date))
          .map((k) => ({ ...k, person: userSummary(k.userId), createdByName: nameOf(k.createdBy) })) };
      }
      if (args.what === 'reviews') {
        // Every review in the period (any source), newest first, with who it names and whether it was answered.
        const range = periodRange(args, { settings: settings(), today: today(), lang: langOf(actor), fail });
        const named = new Map();
        store.list('impactMentions', (m) => { if (m.kind === 'review' && m.status !== 'dismissed') { const l = named.get(m.sourceId) || []; l.push(m); named.set(m.sourceId, l); } return false; });
        const list = store.list('guestReviews', (r) => reviewDay(r) >= range.from && reviewDay(r) <= range.to && (!args.source || r.source === args.source) && (args.stars == null || Math.round(r.rating) === Number(args.stars)))
          .sort((a, b) => b.date.localeCompare(a.date));
        return {
          range, total: list.length,
          items: list.slice(0, 200).map((r) => ({ id: r.id, source: r.source, date: r.date, diningDate: r.diningDate, rating: r.rating, text: r.text, reviewer: r.reviewer, server: r.server,
            replied: !!r.replied, reply: r.reply || '', spans: (named.get(r.id) || []).flatMap((m) => m.spans || []),
            people: (named.get(r.id) || []).map((m) => ({ id: m.id, userId: m.userId, name: m.userId ? nameOf(m.userId) : m.token, status: m.status })) })),
        };
      }
      if (args.what === 'names') {
        const r = team();
        const people = store.list('users', (u) => u.active !== false && !(u.role === 'events' && u.onSchedule !== true)).sort((a, b) => a.name.localeCompare(b.name))
          .map((u) => { const p = r.people.get(u.id); return { id: u.id, name: u.name, first: p?.first || '', nicknames: (p?.names || []).filter((n) => n.kind === 'nickname' || n.kind === 'full').map((n) => n.text), aka: Array.isArray(u.aka) ? u.aka : [], common: !!p && COMMON_WORDS.has(p.first) }; });
        return { people, settings: impactSettings(store), canEditSettings: canChangeSettings(actor) };
      }
      const all = store.list('impactMentions', (m) => m.status === 'needsReview').sort((a, b) => b.date.localeCompare(a.date));
      const work = workIndex(store, all.slice(0, 150).map((m) => m.date));
      return { items: all.slice(0, 150).map((m) => queueView(m, work)).filter(Boolean), total: all.length };
    },

    /** A manager's decision on a match: confirm (with the person, which also reassigns), dismiss, or back to "needs review". */
    'impact.decide': (actor, { id, action, userId } = {}) => {
      needMgr(actor);
      const m = store.get('impactMentions', String(id || ''));
      if (!m) fail(404, 'That match is gone. Reload and try again.');
      if (!['confirm', 'dismiss', 'reopen'].includes(action)) fail(400, 'Pick confirm or dismiss');
      let patch;
      if (action === 'confirm') {
        const who = userId || m.userId;
        if (!who || !store.get('users', who)) fail(400, 'Pick who it is');
        patch = { status: 'confirmed', userId: who, reason: 'manager', auto: false, decidedBy: actor.id, decidedAt: at() };
        if (who !== m.userId) patch.notifiedAt = null;
      } else if (action === 'dismiss') patch = { status: 'dismissed', auto: false, decidedBy: actor.id, decidedAt: at() };
      else patch = { status: 'needsReview', decidedBy: null, decidedAt: null, auto: false, reason: 'reopened' };
      let out = store.update('impactMentions', m.id, patch);
      if (out.kind === 'review') out = maybeNotify(out, store.get('guestReviews', out.sourceId));
      return { mention: out };
    },

    /** Look at every review and reservation note again (after new people join, or names change). Keeps managers' decisions. */
    'impact.rescan': (actor) => {
      needMgr(actor);
      roster = null;
      const reviews = store.list('guestReviews');
      const reservations = store.list('otReservations', (r) => r.notes || r.requestedServer);
      return { reviews: reviews.length, reservations: reservations.length, changed: scanMany({ reviews, reservations }) };
    },

    // ----- kudos a manager adds: a shout-out from Google, Yelp, TripAdvisor, in person, a card… -----
    'impact.saveKudos': (actor, a = {}) => {
      needMgr(actor);
      const u = store.get('users', String(a.userId || ''));
      if (!u) fail(400, 'Pick who the kudos are for');
      if (!KUDOS_SOURCES.includes(a.source)) fail(400, 'Pick where the kudos came from');
      const date = a.date || today();
      if (!DAY.test(date) || date > today() || date < addDays(today(), -KUDOS_DATE_MAX)) fail(400, 'Pick a date in the last year');
      const stars = a.stars == null || a.stars === '' ? null : Math.round(Number(a.stars));
      if (stars != null && !(stars >= 1 && stars <= 5)) fail(400, 'Stars go from 1 to 5');
      const doc = { userId: u.id, source: a.source, stars, date, text: scrub(a.text, 2000), guest: shortName(a.guest) };
      if (a.id) {
        const cur = store.get('kudos', String(a.id));
        if (!cur) fail(404, 'Those kudos are gone');
        return store.update('kudos', cur.id, { ...doc, updatedAt: at(), updatedBy: actor.id });
      }
      const k = store.insert('kudos', { id: uid('kud'), ...doc, createdBy: actor.id, createdAt: at() });
      if (impactSettings(store).notify && u.active !== false && u.id !== actor.id && date >= addDays(today(), -NOTIFY_WITHIN_DAYS)) {
        const quote = k.text ? ` “${k.text.slice(0, 100)}${k.text.length > 100 ? '…' : ''}”` : '';
        notify([u.id], { en: `Kudos! A guest gave you a shout-out.${quote}`, es: `¡Felicidades! Un cliente te reconoció.${quote}` }, '#/kudos');
      }
      return k;
    },
    /** A review was answered (on the review site): replied, and the reply's text for the record. Managers. */
    'impact.saveReply': (actor, { id, reply = '', replied = true } = {}) => {
      needMgr(actor);
      const r = store.get('guestReviews', String(id || ''));
      if (!r) fail(404, 'That review is gone');
      return store.update('guestReviews', r.id, { replied: !!replied, reply: scrub(reply, 4000), repliedAt: replied ? at() : null, repliedBy: replied ? actor.id : null });
    },
    'impact.removeKudos': (actor, { id } = {}) => {
      needMgr(actor);
      if (!store.get('kudos', String(id || ''))) fail(404, 'Those kudos are gone');
      store.remove('kudos', String(id));
      return { ok: true };
    },

    // ----- review exports from Google, Yelp, TripAdvisor (any CSV): preview, then save -----
    'impact.previewReviews': (actor, { source, items } = {}) => {
      needMgr(actor);
      if (!REVIEW_SOURCES.includes(source)) fail(400, 'Pick where the reviews are from');
      return previewReviews(cleanReviewItems(items, { source, fail }));
    },
    'impact.importReviews': (actor, { source, items, fileName, columns, final = true } = {}) => {
      needMgr(actor);
      if (!REVIEW_SOURCES.includes(source)) fail(400, 'Pick where the reviews are from');
      const importId = uid('imp');
      const r = applyReviews(cleanReviewItems(items, { source, fail }), { origin: 'csv', importId });
      if (final) {
        const i = integration(store);
        const rec = { id: importId, at: at(), by: actor.id, kind: 'reviews', source, fileName: text(fileName, 120), counts: r.counts, from: r.from, to: r.to };
        saveIntegration(store, { imports: [rec, ...(i.imports || [])].slice(0, 20), ...(columns && typeof columns === 'object' ? { columns: { ...(i.columns || {}), [source]: cleanColumns(columns) } } : {}) });
      }
      return r;
    },

    // ----- settings: "you were mentioned" notifications, words that are never names; also-known-as names -----
    'impact.saveSettings': (actor, { notify: on, alertLow, ignoreWords } = {}) => {
      needAdmin(actor);
      const patch = {};
      if (typeof on === 'boolean') patch.notify = on;
      if (typeof alertLow === 'boolean') patch.alertLow = alertLow;
      if (ignoreWords !== undefined) {
        if (!Array.isArray(ignoreWords)) fail(400, 'List the words, separated by commas');
        patch.ignoreWords = [...new Set(ignoreWords.map((w) => text(w, 40)).filter(Boolean))].slice(0, 100);
      }
      saveIntegration(store, patch);
      if (patch.ignoreWords) { roster = null; scanMany({ reviews: store.list('guestReviews'), reservations: store.list('otReservations', (r) => r.notes || r.requestedServer) }); }
      return impactSettings(store);
    },
    'impact.setAka': (actor, { userId, aka } = {}) => {
      needMgr(actor);
      const u = store.get('users', String(userId || ''));
      if (!u) fail(404, 'Person not found');
      if (!Array.isArray(aka)) fail(400, 'List the names, separated by commas');
      const clean = [...new Set(aka.map((a) => text(a, 40)).filter((a) => a && fold(a).replace(/[^a-z]/g, '').length >= 2))].slice(0, 10);
      store.update('users', u.id, { aka: clean });
      roster = null;
      const changed = scanMany({ reviews: store.list('guestReviews'), reservations: store.list('otReservations', (r) => r.notes || r.requestedServer) });
      return { aka: clean, changed };
    },
  });

  return { applyReviews, previewReviews, scanMany, planReviews, team: () => team() };
}

/** The columns to remember for a source: { field: 'Header name' }. */
function cleanColumns(c) {
  const out = {};
  for (const [k, v] of Object.entries(c || {}).slice(0, 30)) if (/^[a-zA-Z]{2,20}$/.test(k)) out[k] = v ? text(v, 60) : null;
  return out;
}
