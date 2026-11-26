// CSV exports that go to payroll: the tip report (Tips → CSV) and hours by person (Labor review → Hours CSV).
// Each person gets two name columns, the legal name and the name they go by (core/names.js). `people` is
// the team as the exporting manager got it (app.bootstrap): a legal name held back from them stays blank.
import { NAME_COLUMNS, nameColumns } from './names.js';
import { fmtHours, fmtPoints } from './tips.js';

const cell = (c) => `"${String(c ?? '').replace(/"/g, '""')}"`;
/** Rows of cells → CSV text (every cell quoted). */
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\n');

/** Tips → CSV: one row per person per pool and period, then the week's total and each person's week. */
export function tipsCsvRows(rep, { people = {}, jobName = (id) => id } = {}) {
  const names = (p) => nameColumns(people[p.userId], p.name);
  const rows = [['Pool', 'Period', ...NAME_COLUMNS, 'Positions', 'Hours', 'Hours from', 'Shifts', 'Points', 'Share %', 'Split', 'Adjustment', 'Adjustment notes', 'Amount']];
  for (const pr of rep.pools) {
    for (const per of pr.periods) {
      for (const p of per.people) {
        rows.push([pr.pool.name, per.label, ...names(p), p.jobs.map((j) => jobName(j.jobCodeId)).join(' + '), fmtHours(p.minutes), p.source + (p.estimated ? ' (estimated)' : ''), p.shifts,
          pr.pool.method === 'equal' ? '' : fmtPoints(p.points), p.sharePct.toFixed(2), (p.split / 100).toFixed(2), (p.adjustment / 100).toFixed(2),
          p.adjustments.map((a) => a.note).join('; '), (p.amount / 100).toFixed(2)]);
      }
    }
  }
  rows.push([]);
  rows.push(['Week total', rep.label, '', '', '', '', '', '', '', '', '', '', '', (rep.total / 100).toFixed(2)]);
  for (const p of rep.people) rows.push(['Week', rep.label, ...names(p), '', fmtHours(p.minutes), '', '', '', '', '', '', '', (p.amount / 100).toFixed(2)]);
  return rows;
}

/** Labor review → Hours CSV: each person's scheduled and worked hours for the week (core/labor.js people rows). */
export function hoursCsvRows(review, { people = {}, jobName = (id) => id } = {}) {
  const rows = [['Week of', ...NAME_COLUMNS, 'Positions', 'Scheduled hours', 'Worked hours', 'Overtime hours', 'Scheduled cost', 'Worked cost', 'Tips', 'Hours from']];
  for (const p of review.people || []) {
    rows.push([review.weekStart, ...nameColumns(p.userId ? people[p.userId] : null, p.name), (p.jobs || []).map(jobName).filter(Boolean).join(' + '),
      p.sched.hours, p.actual.hours, p.actual.ot, p.sched.cost.toFixed(2), p.actual.cost.toFixed(2), p.actual.tips.toFixed(2), p.source || (p.matched ? 'schedule' : '')]);
  }
  return rows;
}
