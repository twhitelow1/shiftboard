// Smart import, the part that knows ShiftBoard's data: what importing a file would do (preview) and doing it (apply),
// for the team (employees.import*) and the menu study guide (menu.import*: needs Training in the plan). Merged into
// core/service.js; the web wizard (web/src/pages/SmartImport.jsx), the demo and the Claude connector's tools
// (server/tools/import.js) all call these. Reading the file and matching columns is core/smart-import.js.
//
//   <target>.importMapping  { columns? }                           the columns remembered for this restaurant (saves when sent)
//   <target>.importPreview  { records, options, decisions }       → { rows, counts, … }: nothing is saved
//   <target>.importApply    { records, options, decisions, exclude, fileName, source }
//                                                                  → the preview again, done; audit-logged with counts
//
// Each preview row: new · update (field by field, before → after) · unchanged · check (a possible duplicate, a record
// that matches more than one person or item, or rows of the file that disagree: needs the manager's decision) · skip ·
// problem (why it can't be imported). Apply recomputes everything from the records (never trusts a preview), refuses
// while a "check" row has no decision, and is idempotent: the same file again changes nothing.
//
// decisions: { [row key]: { action: 'update' | 'skip' | 'new', id?: the existing record, keep?: [fields that keep their
// current value], values?: { field: the value picked where rows of the file disagree } } }. 'new' is never a default.
// A decision is remembered (importLinks), so the same row in the next import is matched (or skipped) the same way.
//
// Employees: matched by email, then employee/payroll ID (or the ADP file number), then phone, then a decision made
// before, then the full or legal name. Empty cells keep what's there unless options.blankClears. Never: an Admin or
// Super Admin role, consent (smsConsent / emailConsent are never written; new people start with both off like Team →
// Add), a password (new people sign in through an invitation: options.invite sends them after the save, by email only).
// Positions are added, never taken away. A pay rate goes on the row's positions (else their only or main one).
//
// Future platform sync (Toast, ADP and others): build records { row, values: { field: text }, present } from the
// platform's people and call the same preview/apply. core/adp.js matchWorkers keeps its own links (adpWorkers);
// the employee ID it saves (users.adpId) is one of the IDs matched here.
import { uid } from './store.js';
import { roleOf, canManageUser, assignableRoles } from './roles.js';
import { nameKey, legalNameOf } from './names.js';
import { canonicalAllergen, DEFAULT_CATEGORIES } from './training.js';
import {
  FIELDS, MAX_ROWS, normalizeEmployee, normalizeMenuItem, groupRows, personLikeness, menuLikeness, POSSIBLE_AT,
  normEmail, phoneKey, idKey, itemKey, looseItemKey, isEmptyValue, sameValue, confidenceOf, headerKey, isSensitiveHeader, isMajorAllergen,
} from './smart-import.js';

/**
 * The profile fields an import brings that Team didn't have (employees.save keeps them; Team → a person shows them):
 * hireDate 'YYYY-MM-DD', birthday 'YYYY-MM-DD' or 'MM-DD', employeeId (payroll), notes (managers'). Only those sent.
 */
export function employeeExtrasPatch(a = {}) {
  const out = {};
  const day = (v, yearOptional) => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) || (yearOptional && /^\d{2}-\d{2}$/.test(s)) ? s : ''; };
  if ('hireDate' in a) out.hireDate = day(a.hireDate, false);
  if ('birthday' in a) out.birthday = day(a.birthday, true);
  if ('employeeId' in a) out.employeeId = clean(a.employeeId).slice(0, 40);
  if ('notes' in a) out.notes = String(a.notes ?? '').replace(/\r/g, '').trim().slice(0, 1000);
  return out;
}

/** A preview as callers see it: without the plan apply works from. */
function publicView(p) {
  return {
    rows: p.rows.map(({ plan: _p, linkKey: _l, keepFromLink: _k, cantEdit: _c, present: _pr, ...r }) => r),
    counts: p.counts, checks: p.checks,
    ...(p.newPositions ? { newPositions: p.newPositions } : {}), ...(p.newCategories ? { newCategories: p.newCategories } : {}),
  };
}

const LINKS = 'importLinks';
const MAPPINGS = 'importMappings';
const CHECK_LIMIT = 3; // candidates shown for a possible duplicate
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const asList = (v) => (Array.isArray(v) ? v : isEmptyValue(v) ? [] : [v]);
const show = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? v : v == null ? '' : String(v));

export function importApi({ store, api, fail, needMgr, now }) {
  const iso = () => now().toISOString();

  // ---------------------------------------------------------------- shared

  /** The records as sent, checked: [{ row, values: { field: text }, present: [fields] }]. */
  function cleanRecords(target, records) {
    if (!Array.isArray(records)) fail(400, 'Nothing to import');
    if (records.length > MAX_ROWS) fail(400, `Import up to ${MAX_ROWS} rows at a time`);
    const keys = new Set(FIELDS[target].map((f) => f.key));
    return records.map((r, i) => {
      const values = {};
      for (const [k, v] of Object.entries(r?.values && typeof r.values === 'object' ? r.values : {})) {
        if (keys.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) values[k] = String(v).slice(0, 4000);
      }
      const present = Array.isArray(r?.present) ? r.present.filter((k) => keys.has(k)) : Object.keys(values);
      const row = Number.isInteger(r?.row) && r.row > 0 && r.row < 1e6 ? r.row : i + 1;
      // id: the existing record this row is (a tool updating one item, a future platform sync that knows it).
      const id = typeof r?.id === 'string' && r.id.length < 80 ? r.id : null;
      return { row, values, present: [...new Set([...present, ...Object.keys(values)])], ...(id ? { id } : {}) };
    });
  }
  const linkId = (target, k) => `${target}|${k}`.slice(0, 200);
  const linkOf = (target, k) => (k ? store.get(LINKS, linkId(target, k)) : null);
  function remember(target, k, doc) {
    if (!k) return;
    const id = linkId(target, k);
    const body = { target, ...doc, at: iso() };
    if (store.get(LINKS, id)) store.update(LINKS, id, body); else store.insert(LINKS, { id, ...body });
  }
  const cleanDecision = (d) => {
    if (!d || typeof d !== 'object') return null;
    const action = ['update', 'skip', 'new'].includes(d.action) ? d.action : null;
    return {
      action, id: typeof d.id === 'string' ? d.id : null,
      keep: Array.isArray(d.keep) ? d.keep.filter((k) => typeof k === 'string') : [],
      values: d.values && typeof d.values === 'object' ? d.values : {},
    };
  };
  function pickConflicts(group, dec, existing, getExisting) {
    // Rows of the file that disagree: the manager's pick, else the existing record's value when it's one of them.
    const picked = {};
    const open = [];
    for (const [f, opts] of Object.entries(group.conflicts || {})) {
      const mine = dec && f in dec.values ? opts.find((o) => sameValue(o, dec.values[f])) : undefined;
      if (mine !== undefined) { picked[f] = mine; continue; }
      const cur = existing ? getExisting(existing, f) : undefined;
      const auto = cur !== undefined && !isEmptyValue(cur) ? opts.find((o) => sameValue(o, cur)) : undefined;
      if (auto !== undefined) { picked[f] = auto; continue; }
      open.push(f);
    }
    return { picked, open };
  }
  const countsOf = (rows) => {
    const c = { total: rows.length, new: 0, update: 0, unchanged: 0, check: 0, skip: 0, problem: 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  };
  function audit(actor, target, result, args) {
    store.insert('auditLog', {
      id: uid('aud'), at: iso(), actorId: actor.id, targetId: null, action: `import.${target}`, via: args.via === 'claude' || args.via === 'assistant' ? args.via : 'app',
      details: { fileName: clean(args.fileName).slice(0, 120), source: clean(args.source).slice(0, 20), rows: result.counts.total,
        created: result.created, updated: result.updated, unchanged: result.unchanged, skipped: result.skipped, failed: result.failed.length,
        ...(result.positionsCreated ? { positionsCreated: result.positionsCreated.length } : {}), ...(result.categoriesCreated ? { categoriesCreated: result.categoriesCreated.length } : {}),
        ...(target === 'employees' ? { invite: !!args.options?.invite } : {}) },
    });
  }
  function mappingMethod(target) {
    return (actor, { columns } = {}) => {
      needMgr(actor);
      const id = target;
      if (columns && typeof columns === 'object' && !Array.isArray(columns)) {
        const keys = new Set(FIELDS[target].map((f) => f.key));
        const saved = {};
        for (const [h, f] of Object.entries(columns).slice(0, 80)) {
          const k = headerKey(h);
          if (k && !isSensitiveHeader(k) && (f === '' || keys.has(f))) saved[k] = f;
        }
        const doc = { columns: saved, updatedAt: iso(), updatedBy: actor.id };
        if (store.get(MAPPINGS, id)) store.update(MAPPINGS, id, doc); else store.insert(MAPPINGS, { id, ...doc });
      }
      const m = store.get(MAPPINGS, id);
      return { columns: m?.columns || {}, updatedAt: m?.updatedAt || null };
    };
  }

  /**
   * The common shape of a preview: group the file's rows, find each group's record, apply the manager's decisions,
   * then let the target work out problems and changes. hooks: { normalize, exact(data) → { hits, by }, likeness(data, rec),
   * linkKey(data), getExisting(rec, field), summary(rec), finish(row, ctx) }.
   */
  function previewWith(target, actor, args, hooks) {
    const records = cleanRecords(target, args.records);
    const decisions = Object.fromEntries(Object.entries(args.decisions && typeof args.decisions === 'object' ? args.decisions : {}).map(([k, d]) => [k, cleanDecision(d)]).filter(([, d]) => d));
    const normalized = records.map((r) => ({ ...r, ...hooks.normalize(r.values) }));
    const groups = groupRows(normalized, target);
    const taken = new Map(); // existing id → the row key that claimed it
    const rows = groups.map((g) => {
      const key = `r${g.rows[0].row}`;
      const dec = decisions[key] || null;
      const data = { ...g.data };
      const row = {
        key, rows: g.rows.map((r) => r.row), status: 'new', label: data.name || '', incoming: {}, changes: [], problems: [],
        notes: g.rows.flatMap((r) => r.issues || []), present: g.present,
      };
      // Who or what it is: an exact match, else candidates.
      row.linkKey = hooks.linkKey(data);
      const link = linkOf(target, row.linkKey);
      let target_ = null, by = null, candidates = [], why = null;
      const forced = g.rows.map((r) => r.id && hooks.get(r.id)).find(Boolean);
      const ex = forced ? { hits: [forced], by: 'id' } : hooks.exact(data, link);
      if (ex.hits.length === 1) { target_ = ex.hits[0]; by = ex.by; }
      else if (ex.hits.length > 1) { why = 'ambiguous'; candidates = ex.hits.map((rec) => ({ rec, score: 70, reasons: [ex.by] })); }
      else {
        candidates = hooks.all().map((rec) => ({ rec, ...hooks.likeness(data, rec) })).filter((c) => c.score >= POSSIBLE_AT)
          .sort((a, b) => b.score - a.score).slice(0, CHECK_LIMIT);
        if (candidates.length) why = 'possible';
      }
      if (candidates.length) {
        row.candidates = candidates.map((c) => ({ id: c.rec.id, score: c.score, confidence: confidenceOf(c.score), reasons: c.reasons || [], ...hooks.summary(c.rec) }));
        // A decision from an earlier import of the same row.
        const remembered = !dec && link && (link.skip || candidates.some((c) => c.rec.id === link.recordId)) ? { action: link.skip ? 'skip' : 'update', id: link.recordId || null, keep: link.keep || [], values: {} } : null;
        const d = dec || remembered;
        if (remembered) row.remembered = true;
        if (d?.action === 'skip') row.decision = 'skip';
        else if (d?.action === 'new') row.decision = 'new';
        else if (d?.action === 'update' && candidates.some((c) => c.rec.id === d.id)) { row.decision = 'update'; target_ = hooks.get(d.id); by = 'decision'; }
        else row.decision = null;
        row.why = why;
      }
      const effective = dec || (row.remembered ? { keep: link.keep || [], values: {} } : null);
      if (target_ && link?.recordId === target_.id && !dec && !row.decision) row.keepFromLink = link.keep || [];
      // Rows of the file that disagree.
      const { picked, open } = pickConflicts(g, dec, target_, hooks.getExisting);
      Object.assign(data, picked);
      if (Object.keys(g.conflicts).length) { row.conflicts = g.conflicts; row.picked = picked; }
      row.incoming = hooks.incomingView(data);
      row.label = data.name || (target_ ? hooks.summary(target_).name : '') || '';
      if (target_) { row.match = { id: target_.id, by, ...hooks.summary(target_) }; }
      const needs = [];
      if (row.candidates && !row.decision) needs.push(why);
      if (open.length) { needs.push('inFile'); row.openConflicts = open; }
      if (row.decision === 'skip') { row.status = 'skip'; return row; }
      // A record claimed by two rows of the file: the second one waits.
      if (target_ && taken.has(target_.id)) { row.problems.push({ code: 'sameRecordAs', params: { row: taken.get(target_.id) } }); row.status = 'problem'; return row; }
      if (target_) taken.set(target_.id, key);
      const keep = [...(effective?.keep || []), ...(row.keepFromLink || [])];
      hooks.finish(row, { data, target: target_, keep, options: args.options || {}, actor });
      if (needs.length) { row.status = 'check'; row.needs = needs; row.why = row.why || needs[0]; return row; }
      if (row.problems.length) row.status = 'problem';
      else if (target_) row.status = row.changes.length ? 'update' : 'unchanged';
      else row.status = 'new';
      return row;
    });
    return { rows, counts: countsOf(rows), checks: rows.filter((r) => r.status === 'check').length, decisions };
  }

  /** Apply: the preview again, a decision for every check row, then each new or changed row (one failure doesn't stop the rest). */
  function applyWith(target, actor, args, preview, run) {
    const exclude = new Set(Array.isArray(args.exclude) ? args.exclude.map(String) : []);
    const undecided = preview.rows.filter((r) => r.status === 'check' && !exclude.has(r.key));
    if (undecided.length) fail(409, 'Decide on every possible duplicate first');
    const result = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: [], ids: [] };
    for (const row of preview.rows) {
      if (row.status === 'unchanged') { result.unchanged++; rememberDecision(target, row, preview); continue; }
      if (exclude.has(row.key) || !['new', 'update'].includes(row.status)) {
        result.skipped++;
        if (row.status === 'skip' && !exclude.has(row.key)) rememberDecision(target, row, preview);
        continue;
      }
      try {
        const id = run(row);
        if (row.status === 'new') result.created++; else result.updated++;
        result.ids.push({ key: row.key, id, status: row.status });
        rememberDecision(target, row, preview, id);
      } catch (e) {
        if (!e?.status) throw e;
        result.failed.push({ key: row.key, row: row.rows[0], label: row.label, error: e.message });
      }
    }
    return result;
  }
  /** What the manager decided about a check row, for the next import of the same row. */
  function rememberDecision(target, row, preview, newId) {
    const d = preview.decisions[row.key];
    if (!d || !row.linkKey) return;
    if (d.action === 'skip') remember(target, row.linkKey, { skip: true, recordId: null, keep: [] });
    else if (d.action === 'update' && row.match?.id) remember(target, row.linkKey, { skip: false, recordId: row.match.id, keep: d.keep || [] });
    else if (d.action === 'new' && newId) remember(target, row.linkKey, { skip: false, recordId: newId, keep: [] });
  }

  // ---------------------------------------------------------------- employees

  const jobs = () => store.list('jobCodes').filter((j) => !j.archived);
  const POSITION_WORDS = [
    ['server', 'waiter', 'waitress', 'waitstaff', 'mesero', 'mesera'], ['bartender', 'barman', 'barmaid', 'bar', 'cantinero', 'cantinera', 'barista de bar'],
    ['host', 'hostess', 'anfitrion', 'anfitriona', 'hostes'], ['busser', 'busboy', 'bus boy', 'busperson', 'garrotero', 'ayudante de mesero'],
    ['cook', 'line cook', 'cocinero', 'cocinera', 'linea'], ['dishwasher', 'dish', 'lavaplatos', 'lavalozas', 'steward'], ['barback', 'bar back', 'ayudante de bar'],
    ['runner', 'food runner', 'corredor'], ['prep', 'prep cook', 'preparador'], ['manager', 'gerente'], ['chef', 'cocinero en jefe'], ['sous chef', 'sous'],
  ];
  /** A job code for a position name: its name or short name, or a word that means the same (Waiter = Server, Mesero = Server). */
  function jobFor(name, list = jobs()) {
    const k = nameKey(name);
    if (!k) return null;
    const direct = list.find((j) => nameKey(j.name) === k) || list.find((j) => nameKey(j.short) === k);
    if (direct) return direct;
    const group = POSITION_WORDS.find((g) => g.includes(k));
    return group ? list.find((j) => group.includes(nameKey(j.name))) || null : null;
  }
  const userName = (u) => u?.name || '';
  const userSummary = (u) => ({
    name: u.name, legalName: legalNameOf(u), email: u.email || '', phone: u.phone || '', role: roleOf(u), active: u.active !== false,
    positions: (u.jobCodes || []).map((j) => store.get('jobCodes', j.jobCodeId)?.name).filter(Boolean), employeeId: u.employeeId || u.adpId || '',
    hireDate: u.hireDate || '', birthday: u.birthday || '',
  });
  const EMP_EXISTING = {
    name: (u) => u.name || '', legalFirstName: (u) => u.legalFirstName || '', legalLastName: (u) => u.legalLastName || '', email: (u) => u.email || '',
    phone: (u) => u.phone || '', role: (u) => roleOf(u), hireDate: (u) => u.hireDate || '', birthday: (u) => u.birthday || '',
    employeeId: (u) => u.employeeId || u.adpId || '', notes: (u) => u.notes || '', active: (u) => u.active !== false,
    positions: (u) => (u.jobCodes || []).map((j) => store.get('jobCodes', j.jobCodeId)?.name).filter(Boolean),
  };
  const empSame = {
    name: (a, b) => nameKey(a) === nameKey(b), legalFirstName: (a, b) => nameKey(a) === nameKey(b), legalLastName: (a, b) => nameKey(a) === nameKey(b),
    email: (a, b) => normEmail(a) === normEmail(b), phone: (a, b) => phoneKey(a) === phoneKey(b) && (!!phoneKey(a) || clean(a) === clean(b)),
    employeeId: (a, b) => idKey(a) === idKey(b), notes: (a, b) => clean(a) === clean(b),
  };

  function employeePreview(actor, args) {
    const users = store.list('users');
    const settingsSuperAdmin = users.some((u) => roleOf(u) === 'super_admin' && u.active !== false);
    const canAssign = assignableRoles(actor, { superAdminExists: settingsSuperAdmin });
    const knownJobs = jobs();
    const newPositions = new Map();
    const prev = previewWith('employees', actor, args, {
      normalize: normalizeEmployee,
      all: () => users,
      get: (id) => store.get('users', id),
      linkKey: (d) => nameKey(d.name),
      summary: userSummary,
      getExisting: (u, f) => EMP_EXISTING[f]?.(u),
      incomingView: (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, show(v)])),
      likeness: personLikeness,
      exact(d, link) {
        const email = normEmail(d.email);
        if (email) { const hits = users.filter((u) => normEmail(u.email) === email); if (hits.length) return { hits, by: 'email' }; }
        const id = idKey(d.employeeId);
        if (id) { const hits = users.filter((u) => [u.employeeId, u.adpId].some((x) => idKey(x) === id)); if (hits.length) return { hits, by: 'employeeId' }; }
        // A phone, a remembered decision or a name only when no email or ID on both sides says it's someone else.
        const fits = (u) => !(email && u.email && normEmail(u.email) !== email) && !(id && (u.employeeId || u.adpId) && ![u.employeeId, u.adpId].some((x) => idKey(x) === id));
        const phone = phoneKey(d.phone);
        if (phone) { const hits = users.filter((u) => phoneKey(u.phone) === phone && fits(u)); if (hits.length) return { hits, by: 'phone' }; }
        if (link?.recordId && !link.skip) { const u = store.get('users', link.recordId); if (u && fits(u)) return { hits: [u], by: 'decision' }; }
        const k = nameKey(d.name);
        const lk = nameKey([d.legalFirstName, d.legalLastName].filter(Boolean).join(' '));
        if (k || lk) {
          const byName = users.filter((u) => fits(u) && k && (nameKey(u.name) === k || nameKey(u.sheetName) === k));
          if (byName.length) return { hits: byName, by: 'name' };
          const byLegal = users.filter((u) => fits(u) && legalNameOf(u) && [k, lk].filter(Boolean).includes(nameKey(legalNameOf(u))));
          if (byLegal.length) return { hits: byLegal, by: 'legalName' };
        }
        return { hits: [], by: null };
      },
      finish(row, { data, target: u, keep, options }) {
        row.linkKey = nameKey(data.name);
        const blank = options.blankClears === true;
        const present = new Set(row.present);
        const skipField = (f) => keep.includes(f);
        // Role: never Admin or Super Admin from a file, and only roles this manager may give.
        if (data.role === 'admin') { row.notes.push({ code: 'adminRoleIgnored' }); delete data.role; }
        else if (data.role && !canAssign.includes(data.role) && !(u && roleOf(u) === data.role)) { row.notes.push({ code: 'roleNotAllowed', params: { role: data.role } }); delete data.role; }
        if (!u) {
          if (!data.name) row.problems.push({ code: 'noName' });
        } else if (u.id !== actor.id && !canManageUser(actor, u)) {
          row.cantEdit = true; // problems only if something would change (below)
        }
        // Someone else's email or ID.
        if (data.email) {
          const owner = users.find((x) => normEmail(x.email) === data.email && x.id !== u?.id);
          if (owner) row.problems.push({ code: 'emailTaken', params: { name: owner.name } });
        }
        if (data.employeeId) {
          const owner = users.find((x) => x.id !== u?.id && [x.employeeId, x.adpId].some((y) => idKey(y) && idKey(y) === idKey(data.employeeId)));
          if (owner) row.problems.push({ code: 'idTaken', params: { name: owner.name } });
        }
        // Positions: matched, or made (createPositions), or a problem.
        const posNames = asList(data.positions);
        const jobIds = [];
        const unknown = [];
        for (const p of posNames) {
          const j = jobFor(p, knownJobs);
          if (j) { if (!jobIds.includes(j.id)) jobIds.push(j.id); continue; }
          const k = nameKey(p);
          if (options.createPositions) { if (!newPositions.has(k)) newPositions.set(k, p); jobIds.push(`new:${k}`); } else unknown.push(p);
        }
        if (unknown.length) row.problems.push({ code: 'unknownPosition', params: { names: unknown.join(', ') } });
        if (posNames.some((p) => !jobFor(p, knownJobs)) && options.createPositions) row.notes.push({ code: 'newPositions', params: { names: posNames.filter((p) => !jobFor(p, knownJobs)).join(', ') } });
        row.plan = { jobIds };
        const jobName = (id) => (id.startsWith('new:') ? newPositions.get(id.slice(4)) : store.get('jobCodes', id)?.name || '');
        if (!u) {
          row.plan.doc = data;
          return;
        }
        // Changes, field by field.
        const patch = {};
        const change = (field, before, after) => { row.changes.push({ field, before: show(before), after: show(after) }); };
        for (const f of ['name', 'legalFirstName', 'legalLastName', 'email', 'phone', 'employeeId', 'hireDate', 'birthday', 'notes']) {
          if (!(f in data) || skipField(f)) continue;
          const val = data[f];
          const cur = EMP_EXISTING[f](u);
          if (isEmptyValue(val)) {
            if (blank && present.has(f) && !isEmptyValue(cur) && f !== 'name') { patch[f] = ''; change(f, cur, ''); }
            continue;
          }
          const same = empSame[f] ? empSame[f](cur, val) : clean(cur) === clean(val);
          if (!same) { patch[f] = val; change(f, cur, val); }
        }
        if (data.role && !skipField('role') && data.role !== roleOf(u)) { patch.role = data.role; change('role', roleOf(u), data.role); }
        if (data.active != null && !skipField('active') && data.active !== (u.active !== false)) { patch.active = data.active; change('active', u.active !== false, data.active); }
        // Positions: added to theirs; a pay rate on the row's positions (else their only or main one).
        const curJobs = (u.jobCodes || []).map((j) => ({ ...j }));
        let jobsChanged = false;
        if (!skipField('positions')) {
          const added = jobIds.filter((id) => !curJobs.some((j) => j.jobCodeId === id));
          if (added.length) {
            change('positions', EMP_EXISTING.positions(u), [...EMP_EXISTING.positions(u), ...added.map(jobName)]);
            for (const id of added) curJobs.push({ jobCodeId: id, rate: null, primary: !curJobs.length });
            jobsChanged = true;
          } else if (blank && present.has('positions') && !posNames.length && curJobs.length) {
            change('positions', EMP_EXISTING.positions(u), []);
            curJobs.length = 0;
            jobsChanged = true;
          }
        }
        if (data.payRate != null && !skipField('payRate')) {
          let on = jobIds.length ? curJobs.filter((j) => jobIds.includes(j.jobCodeId)) : curJobs.length === 1 ? curJobs : curJobs.filter((j) => j.primary);
          if (!on.length) row.notes.push({ code: 'rateNoPosition' });
          on = on.filter((j) => Number(j.rate) !== data.payRate);
          for (const j of on) { change('payRate', `${jobName(j.jobCodeId)}: ${j.rate ?? ''}`, `${jobName(j.jobCodeId)}: ${data.payRate}`); j.rate = data.payRate; jobsChanged = true; }
        }
        if (jobsChanged) patch.jobCodes = curJobs;
        if (row.changes.length && row.cantEdit) row.problems.push({ code: 'cantEdit', params: { name: u.name } });
        row.plan.patch = patch;
      },
    });
    prev.newPositions = [...newPositions.values()];
    return prev;
  }

  function employeeApply(actor, args) {
    const preview = employeePreview(actor, args);
    const made = new Map(); // nameKey → job id (positions made by this import)
    const jobId = (id, rows) => {
      if (!id.startsWith('new:')) return id;
      const k = id.slice(4);
      if (!made.has(k)) {
        const name = preview.newPositions.find((n) => nameKey(n) === k) || k;
        const existing = jobFor(name);
        made.set(k, existing ? existing.id : api['jobCodes.save'](actor, { name, order: store.list('jobCodes').length }).id);
      }
      return made.get(k);
    };
    const invite = [];
    const result = applyWith('employees', actor, args, preview, (row) => {
      const rate = row.plan.doc?.payRate ?? null;
      if (row.status === 'new') {
        const d = row.plan.doc;
        const jobCodes = row.plan.jobIds.map((id, i) => ({ jobCodeId: jobId(id), rate, primary: i === 0 }));
        const out = api['employees.save'](actor, {
          name: d.name, email: d.email || '', phone: d.phone || '', role: d.role || 'employee', jobCodes, active: d.active !== false,
          passwordless: true, // they sign in through an invitation (Team → Invite, or options.invite)
          ...(d.legalFirstName ? { legalFirstName: d.legalFirstName } : {}), ...(d.legalLastName ? { legalLastName: d.legalLastName } : {}),
          ...(d.hireDate ? { hireDate: d.hireDate } : {}), ...(d.birthday ? { birthday: d.birthday } : {}), ...(d.employeeId ? { employeeId: d.employeeId } : {}), ...(d.notes ? { notes: d.notes } : {}),
        });
        if (args.options?.invite === true && out.email && out.active !== false) invite.push(out.id);
        return out.id;
      }
      const u = store.get('users', row.match.id);
      const p = row.plan.patch;
      const jobCodes = (p.jobCodes || u.jobCodes || []).map((j) => ({ ...j, jobCodeId: jobId(j.jobCodeId) }));
      api['employees.save'](actor, {
        id: u.id, name: p.name ?? u.name, sheetName: u.sheetName || '', email: p.email ?? u.email ?? '', phone: p.phone ?? u.phone ?? '', role: p.role ?? roleOf(u),
        eventsAccess: !!u.eventsAccess, onSchedule: u.onSchedule !== false, jobCodes, active: p.active ?? u.active !== false, color: u.color || null, maxHours: u.maxHours || null,
        ...['legalFirstName', 'legalLastName', 'hireDate', 'birthday', 'employeeId', 'notes'].reduce((o, k) => (k in p ? { ...o, [k]: p[k] } : o), {}),
      });
      return u.id;
    });
    const out = { ...result, counts: preview.counts, positionsCreated: [...made.keys()].map((k) => preview.newPositions.find((n) => nameKey(n) === k) || k), invite };
    audit(actor, 'employees', out, args);
    return out;
  }

  // ---------------------------------------------------------------- menu

  const items = () => store.list('menuItems');
  const knownCategories = () => {
    const cfg = store.get('trainingConfig', 'main');
    return [...items().map((i) => i.category), ...(Array.isArray(cfg?.categoryOrder) && cfg.categoryOrder.length ? cfg.categoryOrder : DEFAULT_CATEGORIES)].filter(Boolean);
  };
  const itemSummary = (it) => ({ name: it.name, category: it.category || '', description: it.description || '', price: it.price ?? null, allergens: it.allergens || [], dietary: it.dietary || [], eightySixed: !!it.eightySixed });
  // Each menu field: where it lives on an item.
  const MENU_GET = {
    name: (it) => it.name || '', category: (it) => it.category || '', description: (it) => it.description || '', keyIngredients: (it) => it.keyIngredients || [],
    allergens: (it) => it.allergens || [], dietary: (it) => it.dietary || [], price: (it) => it.price ?? null,
    sellingNotes: (it) => it.selling?.notes || '', pairings: (it) => it.selling?.pairings || '', recipeSteps: (it) => it.recipe?.steps || [],
    prepNotes: (it) => it.prep?.notes || '', nameEs: (it) => it.es?.name || '', descriptionEs: (it) => it.es?.description || '', eightySixed: (it) => !!it.eightySixed,
  };
  const MENU_FIELD_ORDER = Object.keys(MENU_GET);
  const menuSame = (f, a, b) => {
    // A name that only differs by a size, plural or "&" keeps its saved spelling ("Mojito (16oz)" is still "Mojito").
    if (f === 'name' || f === 'nameEs') return itemKey(a) === itemKey(b) || (!!looseItemKey(a) && looseItemKey(a) === looseItemKey(b));
    if (f === 'category') return itemKey(a) === itemKey(b);
    if (f === 'allergens') return sameValue(asList(a).map(canonicalAllergen), asList(b).map(canonicalAllergen));
    if (f === 'price') return (a == null && b == null) || Number(a) === Number(b);
    if (f === 'eightySixed') return !!a === !!b;
    if (Array.isArray(a) || Array.isArray(b)) return sameValue(asList(a), asList(b));
    return clean(a) === clean(b);
  };

  function menuPreview(actor, args) {
    const all = items();
    const cats = knownCategories();
    const newCategories = new Map();
    const prev = previewWith('menu', actor, args, {
      normalize: normalizeMenuItem,
      all: () => all,
      get: (id) => store.get('menuItems', id),
      linkKey: (d) => (itemKey(d.name) ? `${itemKey(d.name)}|${itemKey(d.category)}` : ''),
      summary: itemSummary,
      getExisting: (it, f) => MENU_GET[f]?.(it),
      incomingView: (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, show(v)])),
      likeness: menuLikeness,
      exact(d, link) {
        const k = itemKey(d.name);
        if (!k) return { hits: [], by: null };
        if (link?.recordId && !link.skip) { const it = store.get('menuItems', link.recordId); if (it) return { hits: [it], by: 'decision' }; }
        const hits = all.filter((it) => itemKey(it.name) === k && (!d.category || itemKey(it.category) === itemKey(d.category)));
        return { hits, by: 'name' };
      },
      finish(row, { data, target: it, keep, options }) {
        row.linkKey = itemKey(data.name) ? `${itemKey(data.name)}|${itemKey(data.category)}` : '';
        const createCats = options.createCategories !== false;
        if (!it && !data.name) row.problems.push({ code: 'noName' });
        if (data.category && !cats.some((c) => itemKey(c) === itemKey(data.category))) {
          if (createCats) { if (!newCategories.has(itemKey(data.category))) newCategories.set(itemKey(data.category), data.category); row.notes.push({ code: 'newCategory', params: { name: data.category } }); }
          else row.problems.push({ code: 'unknownCategory', params: { name: data.category } });
        }
        const unknownAllergens = asList(data.allergens).filter((a) => !isMajorAllergen(a));
        if (unknownAllergens.length) row.notes.push({ code: 'customAllergens', params: { names: unknownAllergens.join(', ') } });
        if (!it) { row.plan = { doc: data }; return; }
        const blank = options.blankClears === true;
        const present = new Set(row.present);
        const FIELD_OF = { keyIngredients: 'ingredients', sellingNotes: 'selling', recipeSteps: 'recipe', prepNotes: 'prep' };
        const patch = {};
        for (const f of MENU_FIELD_ORDER) {
          if (!(f in data) || keep.includes(f)) continue;
          const val = data[f];
          const cur = MENU_GET[f](it);
          if (isEmptyValue(val)) {
            if (blank && present.has(FIELD_OF[f] || f) && !isEmptyValue(cur) && f !== 'name' && f !== 'category' && f !== 'eightySixed') { patch[f] = Array.isArray(cur) ? [] : f === 'price' ? null : ''; row.changes.push({ field: f, before: show(cur), after: '' }); }
            continue;
          }
          if (!menuSame(f, cur, val)) { patch[f] = val; row.changes.push({ field: f, before: show(cur), after: show(val) }); }
        }
        row.plan = { patch };
      },
    });
    prev.newCategories = [...newCategories.values()];
    return prev;
  }

  /** An item as menu.save takes it, from the current item (or nothing) and the import's fields. */
  function menuDoc(cur, p) {
    const has = (k) => k in p;
    const base = cur || {};
    return {
      ...(cur ? { id: cur.id } : {}),
      name: has('name') ? p.name : base.name, category: has('category') && p.category ? p.category : base.category || p.category || 'Other',
      description: has('description') ? p.description : base.description || '', price: has('price') ? p.price : base.price ?? null,
      keyIngredients: has('keyIngredients') ? p.keyIngredients : base.keyIngredients || [], allergens: has('allergens') ? p.allergens : base.allergens || [],
      dietary: has('dietary') ? p.dietary : base.dietary || [], eightySixed: has('eightySixed') && p.eightySixed != null ? p.eightySixed : !!base.eightySixed,
      selling: { notes: has('sellingNotes') ? p.sellingNotes : base.selling?.notes || '', pairings: has('pairings') ? p.pairings : base.selling?.pairings || '' },
      recipe: { yield: base.recipe?.yield || '', ingredients: base.recipe?.ingredients || [], steps: has('recipeSteps') ? p.recipeSteps : base.recipe?.steps || [] },
      prep: { notes: has('prepNotes') ? p.prepNotes : base.prep?.notes || '' },
      es: { ...(base.es || {}), name: has('nameEs') ? p.nameEs : base.es?.name || '', description: has('descriptionEs') ? p.descriptionEs : base.es?.description || '' },
      visibility: base.visibility || {},
    };
  }

  function menuApply(actor, args) {
    const preview = menuPreview(actor, args);
    const result = applyWith('menu', actor, args, preview, (row) => {
      if (row.status === 'new') return api['menu.save'](actor, menuDoc(null, row.plan.doc)).id;
      const cur = store.get('menuItems', row.match.id);
      return api['menu.save'](actor, menuDoc(cur, row.plan.patch)).id;
    });
    const out = { ...result, counts: preview.counts, categoriesCreated: preview.newCategories };
    audit(actor, 'menu', out, args);
    return out;
  }

  return {
    'employees.importMapping': mappingMethod('employees'),
    'employees.importPreview': (actor, a = {}) => { needMgr(actor); return publicView(employeePreview(actor, a)); },
    'employees.importApply': (actor, a = {}) => { needMgr(actor); return employeeApply(actor, a); },
    'menu.importMapping': mappingMethod('menu'),
    'menu.importPreview': (actor, a = {}) => { needMgr(actor); return publicView(menuPreview(actor, a)); },
    'menu.importApply': (actor, a = {}) => { needMgr(actor); return menuApply(actor, a); },
  };
}
