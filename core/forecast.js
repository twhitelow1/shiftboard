import { addDays, dow, toMin, fromMin, shiftSpan, daysBetween } from './time.js';

/**
 * Forecast covers & sales for a date from same-weekday history.
 * Weighted moving average (recent weeks weigh more) plus a damped trend factor.
 */
export function forecastDay(date, salesByDate, settings, override) {
  const d = dow(date);
  if ((settings.closedDays || []).includes(d)) {
    return { date, covers: 0, sales: 0, closed: true, basis: 'Closed', samples: 0 };
  }
  if (override && (override.covers != null || override.sales != null)) {
    const covers = Number(override.covers) || 0;
    let sales = override.sales;
    let basis = 'Manager override';
    if (sales == null || sales === '') {
      // Covers-only projection (e.g. imported from the schedule): price it at the usual average check.
      const base = forecastDay(date, salesByDate, settings, null);
      sales = base.covers > 0 ? Math.round(covers * (base.sales / base.covers)) : 0;
      basis = 'Projected covers';
    }
    return { date, covers, sales: Number(sales) || 0, basis, override: true, samples: 0 };
  }
  const lookback = settings.forecastWeeks || 8;
  const samples = [];
  for (let w = 1; w <= lookback; w++) {
    const r = salesByDate[addDays(date, -7 * w)];
    if (r && (r.covers > 0 || r.sales > 0)) samples.push({ w, ...r });
  }
  if (!samples.length) {
    return { date, covers: 0, sales: 0, basis: 'No history yet', samples: 0 };
  }
  let wsum = 0, cov = 0, sal = 0;
  for (const s of samples) {
    const weight = lookback + 1 - s.w;
    wsum += weight;
    cov += weight * (Number(s.covers) || 0);
    sal += weight * (Number(s.sales) || 0);
  }
  cov /= wsum;
  sal /= wsum;

  // Trend: last 4 weeks vs previous 4 weeks (all days), damped by half, clamped ±10%.
  let trend = 1;
  const sumRange = (from, to) => {
    let t = 0, n = 0;
    for (let i = from; i < to; i++) {
      const r = salesByDate[addDays(date, -i)];
      if (r && r.covers > 0) { t += Number(r.covers); n++; }
    }
    return n ? t / n : 0;
  };
  const recent = sumRange(1, 29), prior = sumRange(29, 57);
  if (recent && prior) trend = Math.min(1.1, Math.max(0.9, 1 + (recent / prior - 1) / 2));

  const pct = Math.round((trend - 1) * 100);
  return {
    date,
    covers: Math.round(cov * trend),
    sales: Math.round(sal * trend),
    basis: `Weighted avg of ${samples.length} prior ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}s${pct ? `, trend ${pct > 0 ? '+' : ''}${pct}%` : ''}`,
    samples: samples.length,
    trend,
  };
}

/** Resolve a shift's effective end (open-ended shifts run until close). */
export function effectiveShift(shift, settings) {
  if (shift.end) return shift;
  // "Until close": estimate as the shorter of (close - start) and the configured cap, min 3h.
  const h = settings.hours?.[dow(shift.date)];
  const startM = toMin(shift.start);
  const cap = (settings.openEndHours || 7) * 60;
  let dur = cap;
  if (h?.close) {
    const c = toMin(h.close);
    const untilClose = c > startM ? c - startM : c + 1440 - startM;
    dur = Math.min(untilClose, cap);
  }
  dur = Math.max(dur, 180);
  return { ...shift, end: fromMin(startM + dur), estimatedEnd: true };
}

export function hoursOf(shift, settings) {
  const s = effectiveShift(shift, settings);
  const [a, b] = shiftSpan(s);
  return Math.max(0, (b - a - (Number(s.breakMin) || 0)) / 60);
}

/** Is the shift on the floor at a given time of day on its date (handles overnight)? */
export function activeAt(shift, date, time, settings) {
  const s = effectiveShift(shift, settings);
  const [a, b] = shiftSpan(s);
  const t = daysBetween('2000-01-01', date) * 1440 + toMin(time);
  return a <= t && t < b;
}

/** Recommended headcount for one labor rule given a daypart's covers/sales. */
export function recommend(rule, covers, sales) {
  let n = 0;
  if (rule.basis === 'covers') n = rule.per ? Math.ceil(covers / rule.per) : 0;
  else if (rule.basis === 'sales') n = rule.per ? Math.ceil(sales / rule.per) : 0;
  else n = Number(rule.per) || 0; // fixed
  if (covers > 0 || sales > 0 || rule.basis === 'fixed') n = Math.max(n, Number(rule.min) || 0);
  if (rule.max) n = Math.min(n, Number(rule.max));
  return n;
}
