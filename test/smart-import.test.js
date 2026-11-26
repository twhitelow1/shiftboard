// Smart import, the pure parts and the service (core/smart-import.js, core/import-api.js), on the demo data in memory:
//   - reading: CSV/TSV (quotes, BOM, semicolons), DOCX tables (a tiny .docx made here), XLSX, a PDF's text as a table
//   - columns: auto-matching EN/ES headers, value guesses, private columns never imported, mapping memory
//   - people: matched by email / ID / phone / name / legal name; ambiguity and fuzzy rules → "check", with must-NOT-match
//     cases; empty keeps vs blank clears; never an Admin role, never consent, no password; positions matched or made
//   - menu: allergens and dietary tags from free text, fuzzy item rules (plural, &, size, typo, other section)
//   - duplicates inside the file merged with their conflicts; Apply refused until every check row has a decision
//   - idempotent re-import, decisions remembered, audit entries, permissions
// Every name, email and phone number here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import {
  readTable, readDocx, readXlsx, pdfTable, textRows, looksTabular, findHeaderRow, autoMap, rowsToRecords, mappingToRemember,
  normalizeEmployee, normalizeMenuItem, parseAllergens, parseDietary, parseRole, phoneKey, nameLikeness, personLikeness,
  menuLikeness, looseItemKey, groupRows, menuFromText, rosterFromText, templateCsv, editDistance,
} from '../core/smart-import.js';
import { featuresForMethod as planFeaturesFor } from '../server/platform/plans.js';
import { featuresForMethod as roleFeaturesFor } from '../core/role-features.js';

const NOW = new Date(2026, 8, 27, 12);
function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const by = (role) => store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  return { store, svc, by, call };
}
const rec = (row, values) => ({ row, values, present: Object.keys(values) });
const statusOf = (p, key) => p.rows.find((r) => r.key === key)?.status;
/** A person added for a test (invented). */
const addPerson = (store, doc) => store.insert('users', { id: `usr_t_${Math.random().toString(36).slice(2, 8)}`, role: 'employee', active: true, jobCodes: [], availability: {}, ...doc });

// ---------------------------------------------------------------- reading

test('CSV, TSV and semicolons: quotes, doubled quotes, line breaks in a cell, a byte-order mark', () => {
  const csv = '\uFEFFName,Email,Notes\r\n"Rivera, Jamie",jamie@example.com,"Says ""hi""\nand more"\r\n,,\r\nSam Okafor,sam@example.com,\r\n';
  const rows = readTable(csv);
  assert.deepEqual(rows[0], ['Name', 'Email', 'Notes']);
  assert.equal(rows[1][0], 'Rivera, Jamie');
  assert.equal(rows[1][2], 'Says "hi"\nand more');
  assert.equal(rows.length, 3, 'empty rows dropped');
  assert.deepEqual(readTable('Nombre;Correo;Teléfono\nAna;ana@example.com;555-010-1111')[1], ['Ana', 'ana@example.com', '555-010-1111']);
  assert.deepEqual(readTable('Name\tPosition\nKai Lee\tServer')[1], ['Kai Lee', 'Server']);
});

test('DOCX: tables (cells with several paragraphs) and paragraphs, from a .docx made here', () => {
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const cell = (...ps) => `<w:tc><w:tcPr/>${ps.map(p).join('')}</w:tc>`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    ${p('Our team &amp; roles')}
    <w:tbl><w:tr>${cell('Name')}${cell('Email')}${cell('Position')}</w:tr>
      <w:tr>${cell('Jamie Rivers')}${cell('jamie.rivers@example.com')}${cell('Server', 'Bartender')}</w:tr>
      <w:tr>${cell('Sam Okafor')}${cell('sam.okafor@example.com')}${cell('Host')}</w:tr></w:tbl>
    ${p('Last line')}</w:body></w:document>`;
  const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) });
  const d = readDocx(bytes);
  assert.equal(d.tables.length, 1);
  assert.deepEqual(d.tables[0][0], ['Name', 'Email', 'Position']);
  assert.deepEqual(d.tables[0][1], ['Jamie Rivers', 'jamie.rivers@example.com', 'Server Bartender']);
  assert.equal(d.blocks[0].text, 'Our team & roles');
  assert.ok(looksTabular(d.tables[0], 'employees'));
  assert.throws(() => readDocx(zipSync({ 'x.txt': strToU8('no') })), /not a docx/);
});

test('XLSX: the first sheet, shared strings, numbers and gaps', () => {
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2"><v>14.5</v></c></row></sheetData></worksheet>`;
  const shared = '<sst><si><t>Item</t></si><si><t>Category</t></si><si><r><t>Pri</t></r><r><t>ce</t></r></si><si><t>Burrata &amp; Peach</t></si></sst>';
  const bytes = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/sharedStrings.xml': strToU8(shared) });
  assert.deepEqual(readXlsx(bytes), [['Item', 'Category', 'Price'], ['Burrata & Peach', '', '14.5']]);
});

test('PDF text that is a table: lines and columns under the header, titles and repeated headers dropped', () => {
  const at = (str, x, y, page = 1) => ({ page, str, x, y, w: str.length * 5, h: 10 });
  const items = [
    at('Team roster - fall', 40, 20),
    at('Name', 40, 60), at('Email', 200, 60), at('Position', 380, 60),
    at('Jamie', 40, 80), at('Rivers', 72, 80), at('jamie@example.com', 200, 80), at('Server', 380, 80),
    at('Sam Okafor', 40, 100), at('Host', 380, 100), // no email: the cell stays empty
    at('Name', 40, 60, 2), at('Email', 200, 60, 2), at('Position', 380, 60, 2),
    at('Kai Lee', 40, 80, 2), at('kai@example.com', 200, 80, 2), at('Busser', 380, 80, 2),
  ];
  const rows = pdfTable(items, 'employees');
  assert.deepEqual(rows, [['Name', 'Email', 'Position'], ['Jamie Rivers', 'jamie@example.com', 'Server'], ['Sam Okafor', '', 'Host'], ['Kai Lee', 'kai@example.com', 'Busser']]);
  assert.equal(pdfTable([at('Just a paragraph of text', 40, 20)], 'employees'), null);
  // Text that is a table (tabs, 2+ spaces).
  assert.ok(looksTabular(textRows('Name   Email   Phone\nJamie Rivers   jamie@example.com   555-010-1111'), 'employees'));
});

// ---------------------------------------------------------------- columns

test('header auto-mapping in English and Spanish, with confidence; private columns never imported', () => {
  const emp = autoMap(['Nombre', 'Apellido', 'Celular', 'Puesto', 'Correo electrónico', 'Fecha de ingreso', 'SSN', 'Price'], 'employees');
  assert.deepEqual(emp.map((c) => c.field), ['firstName', 'lastName', 'phone', 'positions', 'email', 'hireDate', null, null]);
  assert.equal(emp[0].confidence, 'exact');
  assert.equal(emp[6].sensitive, true, 'SSN: never imported');
  const en = autoMap(['First', 'Last', 'Mobile', 'Job', 'E-mail', 'Employee #', 'Hourly Rate', 'Status'], 'employees');
  assert.deepEqual(en.map((c) => c.field), ['firstName', 'lastName', 'phone', 'positions', 'email', 'employeeId', 'payRate', 'active']);
  // "Role": a position, unless its values are ShiftBoard roles.
  assert.equal(autoMap(['Name', 'Role'], 'employees', { samples: [['A', 'Server'], ['B', 'Bartender']] })[1].field, 'positions');
  assert.equal(autoMap(['Name', 'Role'], 'employees', { samples: [['A', 'Manager'], ['B', 'Employee']] })[1].field, 'role');
  // Values: an unnamed column of emails.
  const guess = autoMap(['Name', 'Contact'], 'employees', { samples: [['A', 'a@example.com'], ['B', 'b@example.com']] });
  assert.deepEqual([guess[1].field, guess[1].confidence], ['email', 'guess']);
  const menu = autoMap(['Platillo', 'Sección', 'Descripción', 'Precio', 'Alérgenos', 'Dieta', 'Agotado'], 'menu');
  assert.deepEqual(menu.map((c) => c.field), ['name', 'category', 'description', 'price', 'allergens', 'dietary', 'eightySixed']);
  // Remembered columns win; private ones are never remembered.
  const remembered = mappingToRemember([{ header: 'Contact', field: 'phone' }, { header: 'SSN', field: 'notes' }, { header: 'Shoe size', field: null }]);
  assert.deepEqual(remembered, { contact: 'phone', 'shoe size': '' });
  const again = autoMap(['Name', 'Contact', 'Shoe size'], 'employees', { remembered });
  assert.deepEqual(again.map((c) => [c.field, c.confidence]), [['name', 'exact'], ['phone', 'remembered'], [null, 'remembered']]);
  assert.equal(findHeaderRow([['Fall roster'], ['Name', 'Email', 'Phone'], ['A', 'a@example.com', '1']], 'employees'), 1);
});

test('records from rows; values cleaned (roles, dates, rates, allergens, dietary)', () => {
  const rows = [['Name', 'Email', 'SSN'], ['Jamie Rivers', ' Jamie@Example.COM ', '000-00-0000'], ['', '', '']];
  const recs = rowsToRecords(rows, 0, autoMap(rows[0], 'employees'));
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].values, { name: 'Jamie Rivers', email: 'Jamie@Example.COM' }, 'the SSN column never gets in');
  const e = normalizeEmployee({ firstName: 'Ana', lastName: 'Ruiz', email: 'ANA@example.com', role: 'Gerente', hireDate: '3/15/2026', birthday: 'Apr 12', payRate: '$15.50', active: 'Inactivo', positions: 'Server / Bartender' });
  assert.deepEqual([e.data.name, e.data.email, e.data.role, e.data.hireDate, e.data.birthday, e.data.payRate, e.data.active], ['Ana Ruiz', 'ana@example.com', 'manager', '2026-03-15', '04-12', 15.5, false]);
  assert.deepEqual(e.data.positions, ['Server', 'Bartender']);
  assert.equal(normalizeEmployee({ name: 'Rivera, Jamie' }).data.name, 'Jamie Rivera');
  assert.deepEqual(normalizeEmployee({ name: 'X', email: 'not-an-email' }).issues.map((i) => i.code), ['badEmail']);
  assert.equal(parseRole('Owner'), 'admin');
  assert.equal(parseRole('Shift lead'), 'supervisor');
  assert.equal(parseRole('Wizard'), null);
  assert.equal(phoneKey('+1 (555) 201-3344'), phoneKey('555.201.3344'));
  assert.deepEqual(parseAllergens('Contains nuts, dairy & gluten'), ['tree nuts', 'milk', 'gluten']);
  assert.deepEqual(parseAllergens('Contiene: leche, huevo y cacahuate'), ['milk', 'eggs', 'peanuts']);
  assert.deepEqual(parseAllergens('None'), []);
  assert.deepEqual(parseDietary('GF, V, VG, DF, picante'), ['gluten-free', 'vegetarian', 'vegan', 'dairy-free', 'spicy']);
  const m = normalizeMenuItem({ name: 'Margarita', category: 'COCKTAILS', price: '$12', available: 'no', recipe: '1. Shake\n2. Strain' });
  assert.deepEqual([m.data.category, m.data.price, m.data.eightySixed, m.data.recipeSteps], ['Cocktails', 12, true, ['Shake', 'Strain']]);
});

test('the simple readers for text that is not a table; templates', () => {
  const menu = menuFromText('STARTERS\nGrilled Bread ...... 9\nolive oil, sea salt\nSoup of the Day - 8\nMAINS\nHalf Chicken  26\nsalsa verde');
  assert.deepEqual(menu.map((r) => [r.values.name, r.values.category, r.values.price, r.values.description]),
    [['Grilled Bread', 'Starters', '9', 'olive oil, sea salt'], ['Soup of the Day', 'Starters', '8', ''], ['Half Chicken', 'Mains', '26', 'salsa verde']]);
  const roster = rosterFromText('Jamie Rivers, jamie@example.com, Server\nSam Okafor  (555) 010-4050  Host\nnothing here');
  assert.deepEqual(roster.map((r) => [r.values.name, r.values.email, r.values.positions]), [['Jamie Rivers', 'jamie@example.com', 'Server'], ['Sam Okafor', '', 'Host']]);
  for (const target of ['employees', 'menu']) {
    const rows = readTable(templateCsv(target));
    assert.equal(rows.length, 3);
    assert.ok(autoMap(rows[0], target).every((c) => c.field), `${target}: every template column maps itself`);
  }
});

// ---------------------------------------------------------------- likeness rules (positive and must-NOT-match)

test('people: fuzzy rules match likely duplicates and leave different people alone', () => {
  const like = (a, b) => nameLikeness(a, b);
  assert.equal(like('Mike Torres', 'Michael Torres').reason, 'nickname');
  assert.equal(like('Torres Michael', 'Michael Torres').reason, 'swapped');
  assert.equal(like('Ana M. Ruiz', 'Ana Ruiz').reason, 'middleInitial');
  assert.equal(like('Jon Lopes', 'Jon Lopez').reason, 'typo');
  assert.equal(like('Alex', 'Alex Moreno').reason, 'firstNameOnly');
  assert.equal(like('José Núñez', 'jose nunez').reason, 'exact', 'accents and case');
  // Must NOT match:
  assert.equal(like('Alex Kim', 'Alex Moreno').score, 0, 'same first name, another last name');
  assert.equal(like('Maria Lopez', 'Mario Lopez').score, 0, 'Maria and Mario are two people');
  assert.equal(like('Sam Okafor', 'Samantha Reyes').score, 0);
  // Emails and IDs that disagree: never the same person, whatever the name.
  const alexA = { id: 'a', name: 'Alex Moreno', email: 'alex.m@example.com' };
  assert.equal(personLikeness({ name: 'Alex Moreno', email: 'alex.k@example.com' }, alexA).score, 0);
  assert.equal(personLikeness({ name: 'Alex', email: 'alex.k@example.com' }, alexA).score, 0, 'two people both called Alex, different emails');
  assert.equal(personLikeness({ name: 'Alex Moreno', employeeId: 'E2' }, { ...alexA, employeeId: 'E1' }).score, 0);
  // Gmail dots and +tags: a likely duplicate, high confidence.
  const g = personLikeness({ name: 'J. Rivers', email: 'jamie.rivers+work@gmail.com' }, { id: 'j', name: 'Jamie Rivers', email: 'jamierivers@gmail.com' });
  assert.deepEqual([g.confidence, g.reasons[0]], ['high', 'emailVariant']);
  // Legal name: the incoming name against the legal name.
  assert.ok(personLikeness({ name: 'Carlos Ortiz' }, { id: 'c', name: 'CJ', legalFirstName: 'Carlos', legalLastName: 'Ortiz' }).reasons.includes('legalName'));
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('menu: fuzzy rules (plural, &, size or price, typo, another section) and what must not match', () => {
  const m = (a, b, cat = 'Drinks', cat2 = 'Drinks') => menuLikeness({ name: a, category: cat }, { name: b, category: cat2 });
  assert.equal(m('Margarita (16oz)', 'Margarita').reasons[0], 'sizeOrPrice');
  assert.equal(m('House Red - Glass', 'House Red').reasons[0], 'sizeOrPrice');
  assert.equal(m('Mojitos', 'Mojito').reasons[0], 'plural');
  assert.equal(m('Mac & Cheese', 'Mac and Cheese').reasons[0], 'andSign');
  assert.equal(m('Carbonara', 'Carbonera').reasons[0], 'typo');
  assert.deepEqual(m('Margarita', 'Margarita', 'Pizza', 'Cocktails').reasons, ['otherCategory']);
  assert.equal(m('Crème Brûlée', 'Creme Brulee').score, 100, 'accents and case: the same name');
  assert.equal(looseItemKey('The Fish Tacos'), looseItemKey('fish taco'));
  // Must NOT match:
  assert.equal(m('Coffee', 'Toffee').score, 0, 'another first letter');
  assert.equal(m('Margherita Pizza', 'Margarita').score, 0);
  assert.equal(m('Beer', 'Bees').score, 0, 'short names: no typo allowance');
  assert.equal(m('Red Wine', 'White Wine').score, 0);
});

test('duplicates inside the file: merged, with the values that disagree kept for the manager', () => {
  const norm = (values, row) => ({ row, ...normalizeEmployee(values), present: Object.keys(values) });
  const g = groupRows([
    norm({ name: 'Jamie Rivers', email: 'jamie@example.com', phone: '555-010-1111' }, 2),
    norm({ name: 'Jamie Rivers', email: 'JAMIE@example.com', phone: '555 010 2222', positions: 'Host' }, 5),
    norm({ name: 'Alex Kim', email: 'alex.k@example.com' }, 3),
    norm({ name: 'Alex Kim', email: 'alexkim@example.net' }, 4), // same name, another email: another person
  ], 'employees');
  assert.equal(g.length, 3);
  assert.deepEqual(g[0].rows.map((r) => r.row), [2, 5]);
  assert.deepEqual(g[0].conflicts, { phone: ['555-010-1111', '555 010 2222'] });
  assert.deepEqual(g[0].data.positions, ['Host'], 'a value only one row has just merges');
  const items = groupRows([2, 3, 4].map((row, i) => ({ row, ...normalizeMenuItem([{ name: 'Old Fashioned', category: 'Cocktails', price: '14' }, { name: 'old-fashioned', price: '15' }, { name: 'Old Fashioned', category: 'Desserts' }][i]) })), 'menu');
  assert.equal(items.length, 2, 'the same name in another section is another item');
  assert.deepEqual(items[0].conflicts, { price: [14, 15] });
});

// ---------------------------------------------------------------- people: preview and apply

test('people: matched by email, ID, phone, name and legal name; new people; positions matched by synonym', () => {
  const { store, by, call } = demo();
  const admin = by('admin');
  const emp = by('employee');
  const lee = addPerson(store, { name: 'Lee Park', email: 'lee.park@example.com', phone: '(555) 010-7777', employeeId: '00412', legalFirstName: 'Leonard', legalLastName: 'Park' });
  const server = store.list('jobCodes').find((j) => j.name === 'Server');
  const p = call(admin, 'employees.importPreview', { records: [
    rec(2, { name: 'Somebody Else', email: emp.email.toUpperCase() }), // email wins over the name
    rec(3, { name: 'L. Park', employeeId: '412' }), // ID, leading zeros ignored
    rec(4, { name: 'Lee P', phone: '+1 555.010.7777' }), // phone, formatting ignored
    rec(5, { name: 'Leonard Park' }), // legal name
    rec(6, { name: 'Quinn Harper', email: 'quinn@example.com', positions: 'Mesero, Sommelier' }), // new; Mesero = Server
  ], options: {} });
  const m = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  assert.deepEqual([m.r2.match.id, m.r2.match.by], [emp.id, 'email']);
  assert.deepEqual([m.r3.match.id, m.r3.match.by], [lee.id, 'employeeId']);
  // r3..r5 all are Lee: the first claims him, the others wait.
  assert.equal(m.r4.status, 'problem');
  assert.equal(m.r4.problems[0].code, 'sameRecordAs');
  assert.equal(m.r6.status, 'problem', 'Sommelier is unknown while "create positions" is off');
  assert.deepEqual(m.r6.problems.map((x) => x.code), ['unknownPosition']);
  const p2 = call(admin, 'employees.importPreview', { records: [rec(6, { name: 'Quinn Harper', email: 'quinn@example.com', positions: 'Mesero, Sommelier' })], options: { createPositions: true } });
  assert.equal(p2.rows[0].status, 'new');
  assert.deepEqual(p2.newPositions, ['Sommelier']);
  const out = call(admin, 'employees.importApply', { records: [rec(6, { name: 'Quinn Harper', email: 'quinn@example.com', positions: 'Mesero, Sommelier', phone: '555-010-3030' })], options: { createPositions: true } });
  assert.equal(out.created, 1);
  const quinn = store.list('users', (u) => u.email === 'quinn@example.com')[0];
  const sommelier = store.list('jobCodes').find((j) => j.name === 'Sommelier');
  assert.deepEqual(quinn.jobCodes.map((j) => j.jobCodeId), [server.id, sommelier.id]);
  // Never consent, never a password: they sign in through an invitation.
  assert.equal(quinn.smsConsent, false);
  assert.equal(quinn.emailConsent, false);
  assert.equal(quinn.passwordHash, null);
  assert.equal(store.list('consents', (c) => c.userId === quinn.id).length, 0, 'no consent records');
  assert.deepEqual(out.invite, [], 'no invitations unless asked');
  // Legal name alone.
  const legal = call(admin, 'employees.importPreview', { records: [rec(9, { name: 'Leonard Park', notes: 'Prefers mornings' })] });
  assert.deepEqual([legal.rows[0].match.id, legal.rows[0].match.by, legal.rows[0].status], [lee.id, 'legalName', 'update']);
});

test('people: ambiguity and fuzzy matches are "check" rows, never merged or created on their own', () => {
  const { store, by, call } = demo();
  const admin = by('admin');
  addPerson(store, { name: 'Alex Moreno', email: 'alex.m@example.com' });
  addPerson(store, { name: 'Alex Moreno', email: 'alex.moreno@example.net' });
  const mike = addPerson(store, { name: 'Michael Torres', email: 'mtorres@example.com', birthday: '04-12' });
  const p = call(admin, 'employees.importPreview', { records: [
    rec(2, { name: 'Alex Moreno' }), // two exact matches
    rec(3, { name: 'Mike Torres', birthday: '4/12' }), // a nickname (+ the same birthday)
  ] });
  const m = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  assert.deepEqual([m.r2.status, m.r2.why, m.r2.candidates.length], ['check', 'ambiguous', 2]);
  assert.deepEqual([m.r3.status, m.r3.why, m.r3.candidates[0].id], ['check', 'possible', mike.id]);
  assert.ok(m.r3.candidates[0].reasons.includes('nickname') && m.r3.candidates[0].reasons.includes('sameBirthday'));
  assert.equal(m.r3.candidates[0].confidence, 'high');
  assert.equal(p.checks, 2);
  const other = call(admin, 'employees.importPreview', { records: [rec(4, { name: 'Alex Moreno', email: 'alex.kim@example.org' })] });
  assert.equal(other.rows[0].status, 'new', 'two different people both called Alex, with different emails');
  const alexK = call(admin, 'employees.importPreview', { records: [rec(4, { name: 'Alex', email: 'alex.kim@example.org' })] });
  assert.equal(alexK.rows[0].status, 'new', 'just "Alex" with another email: not a duplicate of either Alex');
  // Apply is refused until every check row has a decision (or is left out).
  const records = [rec(3, { name: 'Mike Torres', birthday: '4/12', phone: '555-010-8888' })];
  assert.throws(() => call(admin, 'employees.importApply', { records }), (e) => e.status === 409 && /Decide on every possible duplicate/.test(e.message));
  assert.equal(call(admin, 'employees.importApply', { records, exclude: ['r3'] }).skipped, 1, 'left out: skipped');
  // Update the existing one, keeping his name; the decision is remembered.
  const out = call(admin, 'employees.importApply', { records, decisions: { r3: { action: 'update', id: mike.id, keep: ['name'] } } });
  assert.equal(out.updated, 1);
  assert.equal(store.get('users', mike.id).name, 'Michael Torres');
  assert.equal(store.get('users', mike.id).phone, '555-010-8888');
  const again = call(admin, 'employees.importPreview', { records });
  assert.deepEqual([again.rows[0].status, again.rows[0].match.id], ['unchanged', mike.id], 're-import: the same person (the phone now matches), his name kept as decided');
  const byDecision = call(admin, 'employees.importPreview', { records: [rec(3, { name: 'Mike Torres' })] });
  assert.deepEqual([byDecision.rows[0].status, byDecision.rows[0].match.by], ['unchanged', 'decision'], 'the name alone: matched as decided before');
  // "Create as new" needs the explicit decision; then the next import matches the new person exactly.
  const tori = addPerson(store, { name: 'Victoria Lane', email: 'vlane@example.com' });
  const tRec = [rec(7, { name: 'Tori Lane', email: 'tori.lane@example.org' })];
  assert.equal(call(admin, 'employees.importPreview', { records: tRec }).rows[0].status, 'new', 'different emails: not even a check');
  const tRec2 = [rec(7, { name: 'Tori Lane' })];
  const tp = call(admin, 'employees.importPreview', { records: tRec2 });
  assert.deepEqual([tp.rows[0].status, tp.rows[0].candidates[0].id], ['check', tori.id]);
  call(admin, 'employees.importApply', { records: tRec2, decisions: { r7: { action: 'new' } } });
  assert.equal(call(admin, 'employees.importPreview', { records: tRec2 }).rows[0].status, 'unchanged');
  // Skip is remembered too.
  const sRec = [rec(8, { name: 'Torres Michael' })];
  call(admin, 'employees.importApply', { records: sRec, decisions: { r8: { action: 'skip' } } });
  const sp = call(admin, 'employees.importPreview', { records: sRec });
  assert.deepEqual([sp.rows[0].status, sp.rows[0].remembered], ['skip', true]);
});

test('people: rows of the file that disagree need a pick; the existing value counts as one', () => {
  const { store, by, call } = demo();
  const admin = by('admin');
  const records = [rec(2, { name: 'Robin Vale', email: 'robin@example.com', phone: '555-010-1212' }), rec(9, { name: 'Robin Vale', email: 'robin@example.com', phone: '555-010-3434' })];
  const p = call(admin, 'employees.importPreview', { records });
  assert.deepEqual([p.rows.length, p.rows[0].status, p.rows[0].why, p.rows[0].openConflicts], [1, 'check', 'inFile', ['phone']]);
  assert.throws(() => call(admin, 'employees.importApply', { records }), /Decide on every possible duplicate/);
  const out = call(admin, 'employees.importApply', { records, decisions: { r2: { values: { phone: '555-010-3434' } } } });
  assert.equal(out.created, 1);
  assert.equal(store.list('users', (u) => u.email === 'robin@example.com')[0].phone, '555-010-3434');
  // Again: the saved phone is one of the two, so nothing needs deciding and nothing changes.
  const again = call(admin, 'employees.importPreview', { records });
  assert.equal(again.rows[0].status, 'unchanged');
});

test('people: empty cells keep, "blank cells clear" clears; role never Admin; only roles the manager may give', () => {
  const { store, by, call } = demo();
  const admin = by('admin');
  const mgr = by('manager');
  const p = addPerson(store, { name: 'Dana Fox', email: 'dana@example.com', phone: '555-010-5656', notes: 'Closer', employeeId: 'E77' });
  const records = [rec(2, { name: 'Dana Fox', email: 'dana@example.com', phone: '', notes: '', role: 'Admin' })];
  const keep = call(admin, 'employees.importPreview', { records });
  assert.equal(keep.rows[0].status, 'unchanged', 'empty = keep');
  assert.ok(keep.rows[0].notes.some((n) => n.code === 'adminRoleIgnored'));
  const clear = call(admin, 'employees.importPreview', { records, options: { blankClears: true } });
  assert.deepEqual(clear.rows[0].changes.map((c) => c.field).sort(), ['notes', 'phone']);
  call(admin, 'employees.importApply', { records, options: { blankClears: true } });
  assert.deepEqual([store.get('users', p.id).phone, store.get('users', p.id).notes, store.get('users', p.id).employeeId, store.get('users', p.id).role], ['', '', 'E77', 'employee']);
  // A new person listed as Owner: added as an employee, never an Admin.
  call(admin, 'employees.importApply', { records: [rec(3, { name: 'Pat Boss', email: 'patb@example.com', role: 'Owner' })] });
  assert.equal(store.list('users', (u) => u.email === 'patb@example.com')[0].role, 'employee');
  // A manager can't give the Manager role (it stays as it is) and can't edit an Admin.
  const m = call(mgr, 'employees.importPreview', { records: [rec(4, { name: 'Dana Fox', email: 'dana@example.com', role: 'Manager' }), rec(5, { name: admin.name, email: admin.email, phone: '555-010-9999' })] });
  assert.ok(m.rows[0].notes.some((n) => n.code === 'roleNotAllowed'));
  assert.equal(m.rows[0].status, 'unchanged');
  assert.deepEqual([m.rows[1].status, m.rows[1].problems[0].code], ['problem', 'cantEdit']);
});

test('people: pay rate on the row\'s positions, hire date and birthday kept; idempotent; audit-logged', () => {
  const { store, by, call } = demo();
  const admin = by('admin');
  const records = [rec(2, { name: 'Remy Cole', email: 'remy@example.com', positions: 'Server', payRate: '12.50', hireDate: '2026-03-15', birthday: '04-12', employeeId: 'E900', active: 'yes' })];
  const first = call(admin, 'employees.importApply', { records, fileName: 'team.csv', source: 'file' });
  assert.equal(first.created, 1);
  const remy = store.list('users', (u) => u.email === 'remy@example.com')[0];
  assert.deepEqual([remy.jobCodes[0].rate, remy.hireDate, remy.birthday, remy.employeeId], [12.5, '2026-03-15', '04-12', 'E900']);
  const again = call(admin, 'employees.importApply', { records, fileName: 'team.csv' });
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 1], 'the same file again changes nothing');
  const raise = call(admin, 'employees.importPreview', { records: [rec(2, { email: 'remy@example.com', name: 'Remy Cole', payRate: '13' })] });
  assert.deepEqual(raise.rows[0].changes.map((c) => [c.field, c.after]), [['payRate', 'Server: 13']]);
  const log = store.list('auditLog', (a) => a.action === 'import.employees');
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].details.created, log[0].details.fileName, log[0].actorId], [1, 'team.csv', admin.id]);
});

test('permissions: staff can\'t import; the methods need Team (role) and the menu needs Training (plan)', () => {
  const { by, call } = demo();
  for (const role of ['employee', 'supervisor']) {
    for (const m of ['employees.importPreview', 'employees.importApply', 'menu.importPreview', 'menu.importApply', 'employees.importMapping']) {
      assert.throws(() => call(by(role), m, { records: [] }), (e) => e.status === 403, `${role} ${m}`);
    }
  }
  assert.deepEqual(roleFeaturesFor('employees.importApply'), ['team']);
  assert.deepEqual(roleFeaturesFor('menu.importApply'), ['training']);
  assert.deepEqual(planFeaturesFor('menu.importApply'), ['training']);
  assert.deepEqual(planFeaturesFor('employees.importApply'), []);
  assert.throws(() => call(by('admin'), 'employees.importPreview', { records: Array.from({ length: 1001 }, (_, i) => rec(i + 2, { name: `P${i}` })) }), /1000 rows/);
});

test('mapping memory per restaurant and target', () => {
  const { store, by, call } = demo();
  const mgr = by('manager');
  assert.deepEqual(call(mgr, 'employees.importMapping', {}).columns, {});
  call(mgr, 'employees.importMapping', { columns: { 'Cell #': 'phone', Extra: '', SSN: 'notes', Bogus: 'nope' } });
  assert.deepEqual(call(mgr, 'employees.importMapping', {}).columns, { 'cell number': 'phone', extra: '' });
  assert.deepEqual(call(mgr, 'menu.importMapping', {}).columns, {}, 'each target its own');
  assert.ok(store.get('importMappings', 'employees'));
});

// ---------------------------------------------------------------- menu

test('menu: new items with allergens and dietary tags from text; updates keep empty fields; categories', () => {
  const { store, by, call } = demo();
  const mgr = by('manager');
  const burrata = store.list('menuItems').find((i) => /Burrata/.test(i.name));
  const records = [
    rec(2, { name: 'Charred Carrots', category: 'Starters', description: 'Honey glaze', allergens: 'Contains nuts, dairy', dietary: 'GF, V', price: '$11' }),
    rec(3, { name: burrata.name.toUpperCase(), category: burrata.category, price: '19', description: '' }), // exact (case): update the price only
    rec(4, { name: 'Smoked Old Fashioned', category: 'Zero Proof Lab', price: '15' }),
  ];
  const p = call(mgr, 'menu.importPreview', { records, options: { createCategories: false } });
  const m = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  assert.equal(m.r2.status, 'new');
  assert.equal(m.r2.incoming.allergens, 'tree nuts, milk');
  assert.equal(m.r2.incoming.dietary, 'gluten-free, vegetarian');
  assert.deepEqual([m.r3.status, m.r3.changes.map((c) => c.field)], ['update', ['price']]);
  assert.deepEqual([m.r4.status, m.r4.problems[0].code], ['problem', 'unknownCategory']);
  const out = call(mgr, 'menu.importApply', { records, options: { createCategories: true } });
  assert.deepEqual([out.created, out.updated], [2, 1]);
  assert.deepEqual(out.categoriesCreated, ['Zero Proof Lab']);
  const carrots = store.list('menuItems').find((i) => i.name === 'Charred Carrots');
  assert.deepEqual([carrots.allergens, carrots.dietary, carrots.price], [['tree nuts', 'milk'], ['gluten-free', 'vegetarian'], 11]);
  const b = store.get('menuItems', burrata.id);
  assert.equal(b.price, 19);
  assert.equal(b.description, burrata.description, 'an empty cell keeps the description');
  assert.equal(b.name, burrata.name, 'the name keeps its saved spelling');
  // Idempotent.
  const again = call(mgr, 'menu.importApply', { records, options: { createCategories: true } });
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 3]);
  assert.equal(store.list('auditLog', (a) => a.action === 'import.menu').length, 2);
});

test('menu: likely duplicates are checks (plural, size, typo, another section); in-file duplicates merge', () => {
  const { store, by, call } = demo();
  const mgr = by('manager');
  const mojito = store.insert('menuItems', { id: 'mnu_t_mojito', name: 'Mojito', category: 'Cocktails', allergens: [], dietary: [], order: 90 });
  store.insert('menuItems', { id: 'mnu_t_carbonara', name: 'Carbonara', category: 'Mains', allergens: ['eggs'], dietary: [], order: 91 });
  store.insert('menuItems', { id: 'mnu_t_coffee', name: 'Coffee', category: 'Desserts', allergens: [], dietary: [], order: 92 });
  const records = [
    rec(2, { name: 'Mojitos', category: 'Cocktails' }),
    rec(3, { name: 'Mojito (16oz)', category: 'Cocktails', price: '13' }),
    rec(4, { name: 'Carbonera', category: 'Mains' }),
    rec(5, { name: 'Mojito', category: 'Zero Proof' }),
    rec(6, { name: 'Toffee', category: 'Desserts' }),
    rec(7, { name: 'Toffee', category: 'Desserts', price: '7' }),
  ];
  const p = call(mgr, 'menu.importPreview', { records });
  const m = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  assert.deepEqual([m.r2.status, m.r2.candidates[0].id, m.r2.candidates[0].reasons[0]], ['check', mojito.id, 'plural']);
  assert.equal(m.r3.candidates[0].reasons[0], 'sizeOrPrice');
  assert.equal(m.r4.candidates[0].reasons[0], 'typo');
  assert.deepEqual(m.r5.candidates[0].reasons, ['otherCategory']);
  assert.equal(m.r6.status, 'new', 'Toffee is not Coffee');
  assert.deepEqual(m.r6.rows, [6, 7], 'the two Toffee rows merged into one');
  assert.equal(p.checks, 4);
  // Decide: r2 skip, r3 update Mojito (price), r4 new (explicit), r5 skip.
  const decisions = { r2: { action: 'skip' }, r3: { action: 'update', id: mojito.id }, r4: { action: 'new' }, r5: { action: 'skip' } };
  const out = call(mgr, 'menu.importApply', { records, decisions });
  assert.deepEqual([out.created, out.updated, out.skipped], [2, 1, 2]);
  assert.equal(store.get('menuItems', mojito.id).price, 13);
  assert.equal(store.get('menuItems', mojito.id).name, 'Mojito', 'the name keeps its saved spelling (same loose name)');
  // Re-import with no decisions: nothing to decide, nothing changes.
  const again = call(mgr, 'menu.importPreview', { records });
  assert.deepEqual(again.counts, { total: 5, new: 0, update: 0, unchanged: 3, check: 0, skip: 2, problem: 0 });
});

test('managers\' notes and employment details: managers see them; the person never sees the notes; coworkers see neither', () => {
  const { store, by, call } = demo();
  const admin = by('admin');
  const emp = by('employee');
  call(admin, 'employees.importApply', { records: [rec(2, { email: emp.email, name: emp.name, notes: 'Ask before scheduling doubles', hireDate: '2025-05-01', employeeId: 'E5' })] });
  const mine = call(emp, 'app.bootstrap');
  assert.equal(mine.me.notes, undefined);
  assert.equal(mine.employees.find((e) => e.id === emp.id).notes, undefined);
  assert.equal(mine.me.hireDate, '2025-05-01', 'their own hire date is theirs to see');
  const coworker = store.list('users', (u) => u.role === 'employee' && u.id !== emp.id && u.active !== false)[0];
  const theirs = call(coworker, 'app.bootstrap').employees.find((e) => e.id === emp.id);
  assert.deepEqual([theirs.notes, theirs.hireDate, theirs.employeeId], [undefined, undefined, undefined]);
  const mgrView = call(admin, 'app.bootstrap').employees.find((e) => e.id === emp.id);
  assert.deepEqual([mgrView.notes, mgrView.hireDate, mgrView.employeeId], ['Ask before scheduling doubles', '2025-05-01', 'E5']);
  // Team's editor saves them back unchanged (employees.save keeps what it's sent).
  call(admin, 'employees.save', { ...mgrView, jobCodes: mgrView.jobCodes });
  assert.equal(store.get('users', emp.id).notes, 'Ask before scheduling doubles');
});
