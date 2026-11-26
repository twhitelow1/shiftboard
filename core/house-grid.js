// The house schedule workbook as an availability source: the wall-sheet grid (like the schedule PDF) in Excel, one tab
// per week plus a standing-requests tab, where the cell colours carry the meaning. Read by readWorkbook (core/smart-
// import.js); this turns its tabs into availability import records (core/import-api.js, "house" records).
//
// A tab: a "M.O.D." block, then for each room a banner (the room's name alone on its row, in the room's colour), then
// position headers (column A "Servers", "Bar"…, B..H the weekdays), then one row per person (column A the name they go
// by, in capitals) with a cell per day. A week tab has the week's dates (real Excel dates) above its first weekday row;
// the standing tab has none. Rows without a name in column A (day notes, events, MEETING, CLOSED), "Projected Covers"
// rows and covered merged cells aren't people.
//
// What a person's cell means (colours by family, the owner's mapping by default, see colorMap):
//   REQ OFF, green           a standing request off: unavailable that weekday every week
//   REQ OFF, yellow          a request off for that date only (week tabs): time off for the date
//   OFF (any colour), blank  not scheduled that day: nothing to import
//   a time, light green      working that shift in another room than their primary one: a primary-room hint
//   a time (4PM, 1-9PM*, 3:30PM TRAIN, 04:30)  the week's schedule: not availability
//   anything else            REQ OFF with more words ("REQ OFF or", "REQ OFF if needed MONDAY"), WOH, notes: flagged
//                            for the manager, never guessed
import { headerKey, COLOR_FAMILIES, colorFamily } from './smart-import.js';
import { dayOfHeader } from './weekdays.js';
import { nameKey } from './names.js';

export const HOUSE_ACTIONS = ['standing', 'weekOff', 'otherRoom', 'ignore'];
export const DEFAULT_HOUSE_COLORS = { green: 'standing', yellow: 'weekOff', lightGreen: 'otherRoom', red: 'ignore', other: 'ignore' };
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const REQ_OFF = /^(?:req\.?|request(?:ed)?)\s*-?\s*off$/i;
const REQ_OFF_MORE = /^(?:req\.?|request(?:ed)?)\s*-?\s*off\b/i;
const OFF = /^(?:off|libre)$/i;
const TIME = /^\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?(?:\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)?\**(?:\s+[a-z][a-z .'&-]*)?$/i;
const SKIP_ROW = /^(projected\s+)?covers$|^notes?:?$|^m\.?o\.?d\.?$|^events?$/i;

/** The weekday columns of a header row: { col: dow } when B.. hold 5+ weekday names, else null. */
function weekdayColumns(row) {
  const cols = {};
  (row || []).forEach((c, i) => { if (i === 0) return; const d = dayOfHeader(headerKey(c?.text)); if (d >= 0) cols[i] = d; });
  return Object.keys(cols).length >= 5 ? cols : null;
}

/** Is this workbook laid out like the house schedule (a weekday header row and room or position blocks)? */
export function isHouseWorkbook(sheets) {
  return (sheets || []).some((sh) => sh.rows.filter((r) => weekdayColumns(r)).length >= 2);
}

/** A tab's name as a week: "11.16.2026-11.22.2026" → '2026-11-16', else null. */
export function weekOfTabName(name) {
  const m = String(name || '').match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/**
 * One tab → { name, kind: 'week' | 'standing', weekOf, dates: { dow: date }, people: [{ key, name, rows, sections:
 * [{ room, position }], days: { dow: { standing?, dated?, otherRoom?, flag?, text, color } } }], colors: { family:
 * [samples] } }. People are found once per tab (someone in two sections is one person: their days merge).
 */
export function parseHouseTab(sheet) {
  const rows = sheet.rows || [];
  const headers = rows.map(weekdayColumns);
  const first = headers.findIndex(Boolean);
  const out = { name: sheet.name, kind: 'standing', weekOf: null, dates: {}, people: [], colors: {}, skipped: 0 };
  if (first < 0) return out;
  // The dates above the first weekday row (week tabs).
  const above = rows[first - 1] || [];
  for (const [col, d] of Object.entries(headers[first])) { const dt = above[col]?.date; if (dt) out.dates[d] = dt; }
  if (Object.keys(out.dates).length >= 5) {
    out.kind = 'week';
    out.weekOf = Object.values(out.dates).sort()[0];
  } else if (weekOfTabName(sheet.name)) {
    out.kind = 'week';
    out.weekOf = weekOfTabName(sheet.name);
  }
  if (out.kind === 'week' && Object.keys(out.dates).length < 7 && out.weekOf) {
    const start = new Date(`${out.weekOf}T12:00:00Z`);
    for (let i = 0; i < 7; i++) {
      const x = new Date(start); x.setUTCDate(x.getUTCDate() + i);
      const d = x.getUTCDay();
      if (!out.dates[d]) out.dates[d] = x.toISOString().slice(0, 10);
    }
  }
  let cols = headers[first];
  let room = null, position = 'M.O.D.';
  const byKey = new Map();
  for (let r = first + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const a = clean(row[0]?.text);
    if (headers[r]) { cols = headers[r]; position = a || position; continue; } // a position header ("Servers")
    const rest = row.slice(1).filter((c) => clean(c?.text));
    if (a && !rest.length && !row[0]?.merged && /[a-z]/i.test(a) && colorFamily(row[0]?.fill) !== 'none') { room = a; position = null; continue; } // a room banner (in its colour)
    if (!a || row[0]?.merged || SKIP_ROW.test(a) || !/[a-z]/i.test(a)) { if (a || rest.length) out.skipped++; continue; } // notes, covers
    const key = nameKey(a);
    if (!key) continue;
    let p = byKey.get(key);
    if (!p) { p = { key, name: a.replace(/\s+$/, ''), rows: [], sections: [], days: {} }; byKey.set(key, p); out.people.push(p); }
    p.rows.push(r + 1);
    const sec = p.sections.find((s) => s.room === room && s.position === position);
    if (sec) sec.count++; else p.sections.push({ room, position, count: 1 }); // how often they're listed there (rows)
    for (const [col, d] of Object.entries(cols)) {
      const c = row[col];
      if (!c || c.merged) continue;
      const text = clean(c.text);
      const color = colorFamily(c.fill);
      if (color !== 'none' && text) (out.colors[color] ??= []).length < 3 && !out.colors[color].includes(text) && out.colors[color].push(text);
      const day = { text, color };
      if (!text || OFF.test(text)) continue; // not scheduled: nothing to import
      if (REQ_OFF.test(text)) day.reqOff = true;
      else if (REQ_OFF_MORE.test(text) || !(TIME.test(text) || c.time)) day.flag = true; // "REQ OFF or", WOH, a note
      else if (color !== 'none') day.shiftColor = true; // a shift in a colour (light green: another room)
      else continue; // a plain shift time: the schedule, not availability
      const cur = p.days[d];
      // Someone in two sections: one cell per day (a request off wins over a shift, a flag over nothing).
      if (!cur || (day.reqOff && !cur.reqOff) || (day.flag && !cur.reqOff && !cur.flag)) p.days[d] = day;
    }
  }
  return out;
}

/**
 * The tabs picked → availability import records (one per person): { row, values: { name }, present: ['name'], house }.
 * house: { name, sections, standing: [dow], standingTab: bool, dated: [{ date, dow, tab, text, color }], otherRoom:
 * [{ dow, tab }], flags: [{ id, tab, dow, date?, text, color }], mismatch: [{ dow, tab, kind: 'missing' | 'extra' }] }
 * colorMap: family → 'standing' | 'weekOff' | 'otherRoom' | 'ignore' (REQ OFF cells use standing/weekOff; shift cells
 * otherRoom). A REQ OFF whose colour maps to nothing, or a dated one on the standing tab, is flagged.
 */
export function houseRecords(tabs, colorMap = DEFAULT_HOUSE_COLORS) {
  const map = { ...DEFAULT_HOUSE_COLORS, ...(colorMap || {}) };
  const people = new Map();
  const standingTab = tabs.find((t) => t.kind === 'standing');
  let row = 0;
  for (const [ti, t] of tabs.entries()) {
    for (const p of t.people) {
      let h = people.get(p.key);
      if (!h) {
        h = { row: ++row, name: p.name, sections: [], standing: new Set(), weekGreens: [], dated: [], otherRoom: [], flags: [], mismatch: [], standingTab: !!standingTab };
        people.set(p.key, h);
      }
      // Every room block they're listed in, how often, and whether the standing tab lists them there (their primary room).
      for (const s of p.sections) {
        const x = h.sections.find((y) => y.room === s.room && y.position === s.position);
        if (x) { x.count += s.count; if (t.kind === 'standing') x.standing = true; } else h.sections.push({ ...s, ...(t.kind === 'standing' ? { standing: true } : {}) });
      }
      for (const [dk, day] of Object.entries(p.days)) {
        const d = Number(dk);
        const action = day.color === 'none' ? 'ignore' : map[day.color] || 'ignore';
        const flag = (why) => h.flags.push({ id: `${ti}.${d}`, tab: t.name, dow: d, ...(t.dates[d] ? { date: t.dates[d] } : {}), text: day.text, color: day.color, why });
        if (day.flag) { flag('text'); continue; }
        if (day.reqOff) {
          if (action === 'standing') { if (t.kind === 'standing' || !standingTab) h.standing.add(d); else h.weekGreens.push({ dow: d, tab: t.name }); continue; }
          if (action === 'weekOff' && t.kind === 'week' && t.dates[d]) { h.dated.push({ date: t.dates[d], dow: d, tab: t.name, text: day.text, color: day.color }); continue; }
          flag(action === 'weekOff' ? 'noDate' : 'color');
          continue;
        }
        if (day.shiftColor && action === 'otherRoom') h.otherRoom.push({ dow: d, tab: t.name });
      }
    }
  }
  // Week tabs' green REQ OFF against the standing tab: any difference is pointed out.
  for (const h of people.values()) {
    if (!standingTab) continue;
    const seen = new Map();
    for (const g of h.weekGreens) seen.set(g.dow, g.tab);
    for (const [d, tab] of seen) if (!h.standing.has(d)) h.mismatch.push({ dow: d, tab, kind: 'extra' });
  }
  return [...people.values()].map((h) => ({
    row: h.row, values: { name: h.name }, present: ['name'],
    house: { name: h.name, sections: h.sections, standing: [...h.standing].sort(), standingTab: h.standingTab, dated: h.dated, otherRoom: h.otherRoom, flags: h.flags, mismatch: h.mismatch },
  }));
}

/** The colours found on people's cells across tabs, with samples: [{ family, samples }] (for the legend step). */
export function houseColors(tabs) {
  const all = {};
  for (const t of tabs) for (const [f, s] of Object.entries(t.colors)) all[f] = [...new Set([...(all[f] || []), ...s])].slice(0, 3);
  return COLOR_FAMILIES.filter((f) => all[f]).map((family) => ({ family, samples: all[family] }));
}
