// Business logic. Every method takes (actor, args) and enforces permissions itself,
// so the exact same code backs the HTTP API and the in-browser demo.
import { uid } from './store.js';
import { addDays, dow, weekStart, range, overlaps, shiftSpan, todayStr, prettyDate, fmtTime, toMin, daysBetween } from './time.js';
import { forecastDay, effectiveShift, hoursOf, activeAt, recommend } from './forecast.js';
import { suggestStaffing } from './beo.js';
import { ROLE_IDS, roleOf, roleLabel, canManageSchedule, canChangeSettings, canManageEvents, canSeeContacts, canApprove,
  offSchedule, assignableRoles, canManageUser } from './roles.js';

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, msg) => { throw new AppError(status, msg); };

export const DEFAULT_SETTINGS = {
  id: 'settings',
  restaurantName: 'Our Restaurant',
  weekStartDow: 1,
  closedDays: [],
  hours: {
    0: { open: '10:00', close: '22:00' }, 1: { open: '11:00', close: '22:00' }, 2: { open: '11:00', close: '22:00' },
    3: { open: '11:00', close: '22:00' }, 4: { open: '11:00', close: '23:00' }, 5: { open: '11:00', close: '00:00' },
    6: { open: '10:00', close: '00:00' },
  },
  openEndHours: 7,
  overtimeHours: 40,
  requireSwapApproval: true,
  requirePickupApproval: true,
  supervisorsCanApprove: true,
  emailNotifications: true,
  minSwapNoticeHours: 12,
  tags: ['LIB', 'RH', 'FR', 'BC', 'MOON', 'PATIO', 'PASSED', 'BACK HOST', 'CLOSE', 'OPEN'],
  rooms: ['Restaurant', 'Library', 'Rabbit Hole', 'Moon Rabbit', 'Patio', 'Full Buyout'],
  departments: ['Leadership', 'Restaurant', 'Bar', 'Moon Rabbit', 'Host', 'Events', 'Kitchen'],
  dayparts: [
    { name: 'Lunch', start: '11:00', end: '16:00', peak: '12:30', share: 0.3 },
    { name: 'Dinner', start: '16:00', end: '23:00', peak: '19:00', share: 0.7 },
  ],
  laborRules: [],
  forecastWeeks: 8,
  targetLaborPct: 28,
};

const PUBLIC_USER = ({ passwordHash, ...u }) => u;
function randomPassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
// What the client sees for a user: no password hash, and the role in its current form.
const userView = (u) => ({ ...PUBLIC_USER(u), role: roleOf(u), eventsAccess: !!u.eventsAccess || u.role === 'events', onSchedule: !offSchedule(u) });

export function createService(store, opts = {}) {
  const now = opts.now || (() => new Date());
  const hashPassword = opts.hashPassword || ((p) => `plain:${p}`);
  const today = () => todayStr(now());

  // ---------- helpers ----------
  const settings = () => ({ ...DEFAULT_SETTINGS, ...(store.get('settings', 'settings') || {}) });
  const isMgr = (a) => canManageSchedule(a);
  const isEvents = (a) => canManageEvents(a);
  const isApprover = (a) => canApprove(a, settings());
  const needAuth = (a) => { if (!a) fail(401, 'Please sign in'); };
  const needMgr = (a) => { needAuth(a); if (!isMgr(a)) fail(403, 'Managers only'); };
  const needApprover = (a) => { needAuth(a); if (!isApprover(a)) fail(403, 'Managers and supervisors only'); };
  const needEvents = (a) => { needAuth(a); if (!isEvents(a)) fail(403, 'Events team or managers only'); };
  const needAdmin = (a) => { needAuth(a); if (!canChangeSettings(a)) fail(403, 'Admins only'); };
  // Supervisors approve other people's requests, never their own.
  const notOwnRequest = (a, ids) => { if (!isMgr(a) && ids.includes(a.id)) fail(403, 'A manager or another supervisor has to approve your own request'); };
  const users = () => store.list('users');
  const userById = (id) => store.get('users', id);
  const jobById = (id) => store.get('jobCodes', id);
  const nameOf = (id) => userById(id)?.name || 'Open shift';
  const jobName = (id) => jobById(id)?.name || 'Shift';
  const qualified = (user, jobCodeId) => !!user?.jobCodes?.some((j) => j.jobCodeId === jobCodeId);
  const managers = () => users().filter((u) => u.active !== false && canManageSchedule(u));
  const approvers = () => users().filter((u) => u.active !== false && canApprove(u, settings()));
  const describe = (s) => `${jobName(s.jobCodeId)} ${prettyDate(s.date)} ${fmtTime(s.start)}${s.end ? '–' + fmtTime(s.end) : ''}`;
  const isFuture = (s) => {
    const [start] = shiftSpan(s);
    const n = now();
    const nowAbs = daysBetween('2000-01-01', todayStr(n)) * 1440 + n.getHours() * 60 + n.getMinutes();
    return start > nowAbs;
  };

  function notify(userIds, text, link = '') {
    const at = now().toISOString();
    for (const id of new Set(userIds.filter(Boolean))) {
      store.insert('notifications', { id: uid('ntf'), userId: id, text, link, read: false, at });
    }
  }

  function shiftsForUser(userId, from, to) {
    return store.list('shifts', (s) => s.userId === userId && s.date >= from && s.date <= to);
  }

  /** Conflicts that would arise if `userId` worked `shift` (ignoring shifts in `ignoreIds`). */
  function conflictsFor(userId, shift, ignoreIds = []) {
    const st = settings();
    const out = [];
    const user = userById(userId);
    if (!user) return ['Unknown employee'];
    if (user.active === false) out.push(`${user.name} is inactive`);
    if (!qualified(user, shift.jobCodeId)) out.push(`${user.name} isn't trained as ${jobName(shift.jobCodeId)}`);
    const eff = effectiveShift(shift, st);
    const nearby = shiftsForUser(userId, addDays(shift.date, -1), addDays(shift.date, 1))
      .filter((o) => o.id !== shift.id && !ignoreIds.includes(o.id));
    for (const o of nearby) {
      if (overlaps(eff, effectiveShift(o, st))) out.push(`Overlaps ${describe(o)}`);
    }
    const tos = store.list('timeOff', (t) => t.userId === userId && t.status !== 'denied' && t.status !== 'cancelled' &&
      t.startDate <= shift.date && t.endDate >= shift.date);
    for (const t of tos) out.push(t.status === 'approved' ? 'Approved time off' : 'Time-off request pending');
    const av = user.availability?.[dow(shift.date)];
    if (av) {
      if (av.available === false) out.push('Marked unavailable this day');
      else if (av.from && toMin(shift.start) < toMin(av.from)) out.push(`Available from ${fmtTime(av.from)}`);
      else if (av.to && eff.end && toMin(eff.end) > toMin(av.to) && toMin(eff.end) > toMin(eff.start)) out.push(`Available until ${fmtTime(av.to)}`);
    }
    // Overtime for the week containing the shift.
    const ws = weekStart(shift.date, st.weekStartDow);
    const weekShifts = shiftsForUser(userId, ws, addDays(ws, 6)).filter((o) => o.id !== shift.id && !ignoreIds.includes(o.id));
    const hrs = weekShifts.reduce((t, o) => t + hoursOf(o, st), 0) + hoursOf(shift, st);
    if (hrs > st.overtimeHours) out.push(`Overtime: ${hrs.toFixed(1)} hrs this week`);
    return out;
  }

  function visibleShift(actor, s) {
    return isMgr(actor) || s.published;
  }

  function cancelRequestsForShift(shiftId, reason) {
    const active = store.list('requests', (r) => ['open', 'pending_approval'].includes(r.status) &&
      (r.shiftId === shiftId || r.targetShiftId === shiftId));
    for (const r of active) {
      store.update('requests', r.id, { status: 'cancelled', resolvedAt: now().toISOString(), resolution: reason });
      notify([r.requesterId, r.pickupUserId, r.targetUserId], `Request cancelled: ${reason}`, '#/swaps');
    }
  }

  function validateShiftInput(a) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) fail(400, 'Date is required');
    if (!/^\d{2}:\d{2}$/.test(a.start || '')) fail(400, 'Start time is required');
    if (a.end && !/^\d{2}:\d{2}$/.test(a.end)) fail(400, 'End time must be HH:MM');
    if (!jobById(a.jobCodeId)) fail(400, 'Choose a job code');
    if (a.userId && !userById(a.userId)) fail(400, 'Unknown employee');
  }

  const cleanShift = (a) => ({
    date: a.date, start: a.start, end: a.end || null, jobCodeId: a.jobCodeId, userId: a.userId || null,
    tag: (a.tag || '').trim(), notes: (a.notes || '').trim(), breakMin: Number(a.breakMin) || 0,
    eventId: a.eventId || null, staffingLineId: a.staffingLineId || null,
  });

  function executeRequest(r) {
    const shift = store.get('shifts', r.shiftId);
    if (!shift) fail(409, 'Shift no longer exists');
    if (r.type === 'swap') {
      const target = store.get('shifts', r.targetShiftId);
      if (!target) fail(409, 'The other shift no longer exists');
      if (shift.userId !== r.requesterId || target.userId !== r.targetUserId) fail(409, 'Shifts changed since this request was made');
      store.update('shifts', shift.id, { userId: r.targetUserId });
      store.update('shifts', target.id, { userId: r.requesterId });
      cancelOthers(r, [shift.id, target.id]);
    } else {
      // drop or pickup: shift moves to pickupUserId
      if (r.type === 'drop' && shift.userId !== r.requesterId) fail(409, 'Shift changed since this request was made');
      if (r.type === 'pickup' && shift.userId) fail(409, 'Shift was already filled');
      store.update('shifts', shift.id, { userId: r.pickupUserId });
      cancelOthers(r, [shift.id]);
    }
  }

  function cancelOthers(r, shiftIds) {
    const others = store.list('requests', (o) => o.id !== r.id && ['open', 'pending_approval'].includes(o.status) &&
      (shiftIds.includes(o.shiftId) || shiftIds.includes(o.targetShiftId)));
    for (const o of others) {
      store.update('requests', o.id, { status: 'denied', resolvedAt: now().toISOString(), resolution: 'Shift was given to someone else' });
      notify([o.requesterId, o.pickupUserId], `Your request for ${describe(store.get('shifts', o.shiftId))} was closed — it was filled.`, '#/swaps');
    }
  }

  function requestView(r) {
    const shift = store.get('shifts', r.shiftId);
    const target = r.targetShiftId ? store.get('shifts', r.targetShiftId) : null;
    let warnings = [];
    if (['open', 'pending_approval'].includes(r.status) && shift) {
      if (r.type === 'swap' && target) {
        warnings = [
          ...conflictsFor(r.targetUserId, shift, [target.id]).map((w) => `${nameOf(r.targetUserId)}: ${w}`),
          ...conflictsFor(r.requesterId, target, [shift.id]).map((w) => `${nameOf(r.requesterId)}: ${w}`),
        ];
      } else if (r.pickupUserId) {
        warnings = conflictsFor(r.pickupUserId, shift).map((w) => `${nameOf(r.pickupUserId)}: ${w}`);
      }
    }
    return { ...r, shift, targetShift: target, warnings };
  }

  function computeForecastWeek(ws) {
    const st = settings();
    const days = range(ws, 7);
    const salesByDate = {};
    for (const r of store.list('sales', (r) => r.date >= addDays(ws, -7 * 17) && r.date < ws)) salesByDate[r.date] = r;
    const overrides = {};
    for (const o of store.list('forecastOverrides', (o) => o.date >= ws && o.date <= addDays(ws, 6))) overrides[o.date] = o;
    const shifts = store.list('shifts', (s) => s.date >= ws && s.date <= addDays(ws, 6));
    const events = store.list('events', (e) => e.date >= ws && e.date <= addDays(ws, 6) && e.status !== 'cancelled');
    const actuals = {};
    for (const r of store.list('sales', (r) => r.date >= ws && r.date <= addDays(ws, 6))) actuals[r.date] = r;
    const jobCodes = store.list('jobCodes').filter((j) => !j.archived);

    const rate = (s) => {
      const u = s.userId ? userById(s.userId) : null;
      const own = u?.jobCodes?.find((j) => j.jobCodeId === s.jobCodeId)?.rate;
      return Number(own ?? jobById(s.jobCodeId)?.defaultRate ?? 0) || 0;
    };

    const out = days.map((date) => {
      const f = forecastDay(date, salesByDate, st, overrides[date]);
      const dayEvents = events.filter((e) => e.date === date);
      const eventGuests = dayEvents.reduce((t, e) => t + (Number(e.guestCount) || 0), 0);
      const eventRevenue = dayEvents.reduce((t, e) => t + (Number(e.estRevenue) || 0), 0);
      const dayShifts = shifts.filter((s) => s.date === date);
      const hours = dayShifts.reduce((t, s) => t + hoursOf(s, st), 0);
      const cost = dayShifts.reduce((t, s) => t + hoursOf(s, st) * rate(s), 0);
      const totalSales = f.sales + eventRevenue;
      const dayparts = f.closed ? [] : (st.dayparts || []).map((dp) => {
        const covers = Math.round(f.covers * (dp.share || 0));
        const sales = Math.round(f.sales * (dp.share || 0));
        const rows = jobCodes.map((jc) => {
          const rules = (st.laborRules || []).filter((r) => r.jobCodeId === jc.id && (!r.daypart || r.daypart === dp.name));
          const recommended = rules.length ? Math.max(...rules.map((r) => recommend(r, covers, sales))) : null;
          const scheduled = dayShifts.filter((s) => s.jobCodeId === jc.id && !s.eventId && activeAt(s, date, dp.peak || dp.start, st)).length;
          return { jobCodeId: jc.id, recommended, scheduled, gap: recommended == null ? 0 : recommended - scheduled };
        }).filter((r) => r.recommended != null || r.scheduled > 0);
        return { name: dp.name, start: dp.start, end: dp.end, peak: dp.peak, covers, sales, rows };
      });
      return {
        ...f, dow: dow(date), events: dayEvents.map((e) => ({ id: e.id, name: e.name, guestCount: e.guestCount, start: e.start, room: e.room })),
        eventGuests, eventRevenue, totalCovers: f.covers + eventGuests, totalSales,
        hours: +hours.toFixed(1), laborCost: Math.round(cost),
        laborPct: totalSales ? +((cost / totalSales) * 100).toFixed(1) : null,
        actual: actuals[date] || null, dayparts,
      };
    });
    const tot = out.reduce((t, d) => ({ sales: t.sales + d.totalSales, cost: t.cost + d.laborCost, hours: t.hours + d.hours, covers: t.covers + d.totalCovers }), { sales: 0, cost: 0, hours: 0, covers: 0 });
    return { weekStart: ws, days: out, totals: { ...tot, hours: +tot.hours.toFixed(1), laborPct: tot.sales ? +((tot.cost / tot.sales) * 100).toFixed(1) : null }, targetLaborPct: st.targetLaborPct };
  }

  function eventView(e, actor) {
    const shifts = store.list('shifts', (s) => s.eventId === e.id && visibleShift(actor, s));
    const staffing = (e.staffing || []).map((line) => {
      const ls = shifts.filter((s) => s.staffingLineId === line.id);
      return { ...line, created: ls.length, filled: ls.filter((s) => s.userId).length };
    });
    const needed = staffing.reduce((t, l) => t + (Number(l.count) || 0), 0);
    const filled = staffing.reduce((t, l) => t + Math.min(l.filled, Number(l.count) || 0), 0);
    return { ...e, staffing, shifts, needed, filled };
  }

  // ---------- API ----------
  const api = {
    'app.bootstrap': (actor) => {
      needAuth(actor);
      const st = settings();
      const jobCodes = store.list('jobCodes').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const employees = users().map((u) => {
        const pub = userView(u);
        if (isMgr(actor) || u.id === actor.id) return pub;
        const basic = { id: u.id, name: u.name, role: pub.role, active: u.active, color: u.color, onSchedule: pub.onSchedule, jobCodes: (u.jobCodes || []).map((j) => ({ jobCodeId: j.jobCodeId })) };
        return canSeeContacts(actor) ? { ...basic, email: u.email, phone: u.phone } : basic;
      }).sort((a, b) => a.name.localeCompare(b.name));
      const me = userView(userById(actor.id));
      const unread = store.list('notifications', (n) => n.userId === actor.id && !n.read).length;
      const pendingApprovals = isApprover(actor) ? store.list('requests', (r) => r.status === 'pending_approval').length
        + store.list('timeOff', (t) => t.status === 'pending').length : 0;
      const openOffers = store.list('requests', (r) => r.status === 'open' && (
        (r.type === 'swap' && r.targetUserId === actor.id) ||
        (r.type === 'drop' && r.requesterId !== actor.id && qualified(me, store.get('shifts', r.shiftId)?.jobCodeId)))).length;
      return { settings: st, jobCodes, employees, me, unread, pendingApprovals, openOffers, today: today() };
    },

    // ----- settings -----
    'settings.update': (actor, patch) => {
      needAdmin(actor);
      const allowed = ['restaurantName', 'weekStartDow', 'closedDays', 'hours', 'openEndHours', 'overtimeHours', 'requireSwapApproval',
        'requirePickupApproval', 'supervisorsCanApprove', 'emailNotifications', 'minSwapNoticeHours', 'tags', 'rooms', 'departments', 'dayparts', 'forecastWeeks', 'targetLaborPct', 'laborRules'];
      const clean = {};
      for (const k of allowed) if (k in patch) clean[k] = patch[k];
      const cur = store.get('settings', 'settings');
      return cur ? store.update('settings', 'settings', clean) : store.insert('settings', { ...DEFAULT_SETTINGS, ...clean });
    },
    'settings.laborRules': (actor, { laborRules }) => {
      needMgr(actor);
      const cur = store.get('settings', 'settings');
      const rules = (laborRules || []).map((r) => ({ id: r.id || uid('rule'), jobCodeId: r.jobCodeId, daypart: r.daypart || '', basis: r.basis || 'covers', per: Number(r.per) || 0, min: Number(r.min) || 0, max: Number(r.max) || 0 }));
      return cur ? store.update('settings', 'settings', { laborRules: rules }) : store.insert('settings', { ...DEFAULT_SETTINGS, laborRules: rules });
    },

    // ----- job codes -----
    'jobCodes.save': (actor, a) => {
      needMgr(actor);
      if (!a.name?.trim()) fail(400, 'Name is required');
      const doc = { name: a.name.trim(), short: (a.short || a.name.slice(0, 4)).toUpperCase().trim(), department: a.department || 'Restaurant', color: a.color || '#6366f1', defaultRate: Number(a.defaultRate) || 0, order: Number(a.order) || 0, eventRole: !!a.eventRole, archived: !!a.archived };
      return a.id ? store.update('jobCodes', a.id, doc) : store.insert('jobCodes', { id: uid('job'), ...doc });
    },
    'jobCodes.delete': (actor, { id }) => {
      needMgr(actor);
      if (store.list('shifts', (s) => s.jobCodeId === id).length) return store.update('jobCodes', id, { archived: true });
      store.remove('jobCodes', id);
      return { ok: true };
    },

    // ----- employees -----
    'employees.save': (actor, a) => {
      needMgr(actor);
      if (!a.name?.trim()) fail(400, 'Name is required');
      const email = (a.email || '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'That email doesn’t look right');
      if (email && users().some((u) => u.email === email && u.id !== a.id)) fail(400, 'That email is already in use');
      const cur = a.id ? userById(a.id) : null;
      if (a.id && !cur) fail(404, 'User not found');
      const self = cur?.id === actor.id;
      const role = a.role || (cur ? roleOf(cur) : 'employee');
      if (!ROLE_IDS.includes(role)) fail(400, 'Unknown role');
      const active = a.active !== false;

      if (self) {
        if (role !== roleOf(cur)) fail(400, 'You can’t change your own role. Ask another admin.');
        if (!active) fail(400, 'You can’t deactivate yourself.');
      } else {
        if (cur && !canManageUser(actor, cur)) fail(403, `Only a higher role can edit ${/^[AEIOU]/.test(roleLabel(cur)) ? 'an' : 'a'} ${roleLabel(cur)}`);
        const superAdminExists = users().some((u) => roleOf(u) === 'super_admin' && u.active !== false);
        if (!assignableRoles(actor, { superAdminExists }).includes(role)) fail(403, `You can’t give someone the ${roleLabel(role)} role`);
      }
      // Never leave the account without an active Super Admin.
      if (cur && roleOf(cur) === 'super_admin' && (role !== 'super_admin' || !active)
        && !users().some((u) => u.id !== cur.id && roleOf(u) === 'super_admin' && u.active !== false)) {
        fail(400, 'There must always be at least one active Super Admin. Make someone else a Super Admin first.');
      }
      if (a.password && String(a.password).length < 6) fail(400, 'Password must be at least 6 characters');

      const doc = {
        name: a.name.trim(), email, phone: (a.phone || '').trim(), role,
        eventsAccess: !!a.eventsAccess, onSchedule: a.onSchedule !== false,
        jobCodes: (a.jobCodes || []).filter((j) => jobById(j.jobCodeId)).map((j) => ({ jobCodeId: j.jobCodeId, rate: j.rate === '' || j.rate == null ? null : Number(j.rate), primary: !!j.primary })),
        active, color: a.color || null, maxHours: Number(a.maxHours) || null,
      };
      if (cur) {
        const patch = { ...doc };
        if (a.password) {
          patch.passwordHash = hashPassword(a.password);
          if (!self) patch.sessionVersion = (cur.sessionVersion || 0) + 1; // a reset signs them out everywhere
        }
        if (!active && cur.active !== false) patch.sessionVersion = (patch.sessionVersion ?? cur.sessionVersion ?? 0) + 1;
        const u = store.update('users', cur.id, patch);
        if (role !== roleOf(cur)) notify([cur.id], `Your role is now ${roleLabel(role)}.`, '#/my');
        return userView(u);
      }
      const tempPassword = a.password || randomPassword();
      const u = store.insert('users', { id: uid('usr'), ...doc, availability: {}, passwordHash: hashPassword(tempPassword), createdAt: now().toISOString(), createdBy: actor.id });
      return { ...userView(u), tempPassword };
    },
    'employees.setAvailability': (actor, { userId, availability }) => {
      needAuth(actor);
      const id = userId || actor.id;
      if (id !== actor.id && !isMgr(actor)) fail(403, 'You can only edit your own availability');
      return PUBLIC_USER(store.update('users', id, { availability }));
    },
    'account.preferences': (actor, { emailNotifications }) => {
      needAuth(actor);
      return userView(store.update('users', actor.id, { emailNotifications: emailNotifications !== false }));
    },
    'employees.changePassword': (actor, { password }) => {
      needAuth(actor);
      if (!password || password.length < 6) fail(400, 'Password must be at least 6 characters');
      store.update('users', actor.id, { passwordHash: hashPassword(password) });
      return { ok: true };
    },

    // ----- shifts -----
    'shifts.list': (actor, { start, end }) => {
      needAuth(actor);
      const shifts = store.list('shifts', (s) => s.date >= start && s.date <= end && visibleShift(actor, s));
      const timeOff = store.list('timeOff', (t) => t.status !== 'cancelled' && t.status !== 'denied' && t.endDate >= start && t.startDate <= end && (isMgr(actor) || t.status === 'approved'))
        .map((t) => (isMgr(actor) || t.userId === actor.id ? t : { id: t.id, userId: t.userId, startDate: t.startDate, endDate: t.endDate, status: t.status }));
      const events = store.list('events', (e) => e.date >= start && e.date <= end && e.status !== 'cancelled')
        .map((e) => ({ id: e.id, name: e.name, date: e.date, start: e.start, end: e.end, room: e.room, guestCount: e.guestCount, status: e.status, captainId: e.captainId }));
      const activeReq = store.list('requests', (r) => ['open', 'pending_approval'].includes(r.status));
      const pendingByShift = {};
      for (const r of activeReq) { pendingByShift[r.shiftId] = r.type; if (r.targetShiftId) pendingByShift[r.targetShiftId] = r.type; }
      let warnings = {};
      if (isMgr(actor)) for (const s of shifts) if (s.userId) { const w = conflictsFor(s.userId, s); if (w.length) warnings[s.id] = w; }
      const st = settings();
      return { shifts: shifts.map((s) => ({ ...s, hours: +hoursOf(s, st).toFixed(2), pending: pendingByShift[s.id] || null })), timeOff, events, warnings };
    },
    'shifts.save': (actor, a) => {
      needMgr(actor);
      validateShiftInput(a);
      const doc = cleanShift(a);
      if (a.id) {
        const cur = store.get('shifts', a.id);
        if (!cur) fail(404, 'Shift not found');
        if (cur.userId !== doc.userId || cur.date !== doc.date || cur.start !== doc.start) cancelRequestsForShift(a.id, 'the shift was changed by a manager');
        const upd = store.update('shifts', a.id, doc);
        if (cur.published) {
          if (cur.userId && cur.userId !== doc.userId) notify([cur.userId], `You were removed from ${describe(cur)}`, '#/my');
          if (doc.userId) notify([doc.userId], cur.userId === doc.userId ? `Your shift changed: ${describe(upd)}` : `You were added to ${describe(upd)}`, '#/my');
        }
        return { shift: upd, warnings: doc.userId ? conflictsFor(doc.userId, upd) : [] };
      }
      const s = store.insert('shifts', { id: uid('shf'), ...doc, published: !!a.published, createdAt: now().toISOString(), createdBy: actor.id });
      if (s.published && s.userId) notify([s.userId], `New shift: ${describe(s)}`, '#/my');
      return { shift: s, warnings: s.userId ? conflictsFor(s.userId, s) : [] };
    },
    'shifts.delete': (actor, { id }) => {
      needMgr(actor);
      const s = store.get('shifts', id);
      if (!s) return { ok: true };
      cancelRequestsForShift(id, 'the shift was removed');
      store.remove('shifts', id);
      if (s.published && s.userId) notify([s.userId], `Shift removed: ${describe(s)}`, '#/my');
      return { ok: true };
    },
    'shifts.bulkCreate': (actor, { shifts, publish }) => {
      needMgr(actor);
      const created = [];
      store.transaction(() => {
        for (const a of shifts || []) {
          validateShiftInput(a);
          created.push(store.insert('shifts', { id: uid('shf'), ...cleanShift(a), published: !!publish, createdAt: now().toISOString(), createdBy: actor.id }));
        }
      });
      return { created: created.length };
    },
    // Everything a schedule import creates, in one all-or-nothing step (see web/src/pages/ImportDialog.jsx).
    // References to people and job codes are either existing ids or keys of the new ones listed here.
    'import.apply': (actor, a) => {
      needMgr(actor);
      const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#e11d48', '#475569', '#ca8a04', '#0f766e', '#a855f7', '#7c2d12', '#db2777'];
      const at = now().toISOString();
      const out = { jobCodes: 0, employees: 0, shifts: 0, duplicates: 0, invalid: 0, jobsAdded: 0, timeOff: 0, events: 0, covers: 0 };
      const jobRef = {}, userRef = {};
      let order = store.list('jobCodes').reduce((m, j) => Math.max(m, Number(j.order) || 0), 0);
      for (const j of a.newJobCodes || []) {
        const name = String(j.name || '').trim();
        if (!name) fail(400, 'Every new job code needs a name');
        const same = store.list('jobCodes', (x) => x.name.trim().toLowerCase() === name.toLowerCase())[0];
        if (same) { jobRef[j.key] = same.id; continue; }
        const words = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
        const short = (words.length > 1 ? words.map((w) => w[0]).join('') : name).slice(0, 4).toUpperCase();
        order += 1;
        jobRef[j.key] = store.insert('jobCodes', { id: uid('job'), name, short, department: String(j.department || 'Restaurant').trim(), color: PALETTE[order % PALETTE.length],
          defaultRate: Number(j.defaultRate) || 0, order, eventRole: false, archived: false }).id;
        out.jobCodes++;
      }
      const job = (ref) => jobRef[ref] || (ref && jobById(ref) ? ref : null);
      for (const p of a.newEmployees || []) {
        const name = String(p.name || '').trim();
        if (!name || userRef[p.key]) continue;
        const ids = [...new Set((p.jobs || []).map(job).filter(Boolean))];
        // No password yet: a manager adds their email and sends a sign-in link from Team.
        userRef[p.key] = store.insert('users', { id: uid('usr'), name, email: '', phone: '', role: 'employee', active: true, eventsAccess: false, onSchedule: true,
          jobCodes: ids.map((id, i) => ({ jobCodeId: id, rate: null, primary: i === 0 })), availability: {}, passwordHash: null, createdAt: at, createdBy: actor.id }).id;
        out.employees++;
      }
      const user = (ref) => userRef[ref] || (ref && userById(ref) ? ref : null);

      const seen = new Set(store.list('shifts', (s) => s.userId).map((s) => `${s.userId}|${s.date}|${s.start}`));
      const addJobs = new Map(); // people scheduled for a job code they don't hold yet
      for (const s of a.shifts || []) {
        const userId = user(s.user), jobCodeId = job(s.job);
        if (!userId || !jobCodeId) continue;
        try { validateShiftInput({ ...s, userId, jobCodeId }); } catch { out.invalid++; continue; }
        const key = `${userId}|${s.date}|${s.start}`;
        if (a.skipDuplicates !== false && seen.has(key)) { out.duplicates++; continue; }
        seen.add(key);
        store.insert('shifts', { id: uid('shf'), ...cleanShift({ ...s, userId, jobCodeId }), published: false, createdAt: at, createdBy: actor.id });
        out.shifts++;
        if (!qualified(userById(userId), jobCodeId)) addJobs.set(userId, new Set([...(addJobs.get(userId) || []), jobCodeId]));
      }
      for (const [userId, ids] of addJobs) {
        const u = userById(userId);
        if (u.id !== actor.id && !canManageUser(actor, u)) continue;
        const had = u.jobCodes || [];
        store.update('users', userId, { jobCodes: [...had, ...[...ids].map((id, i) => ({ jobCodeId: id, rate: null, primary: !had.length && i === 0 }))] });
        out.jobsAdded += ids.size;
      }

      for (const t of a.timeOff || []) {
        const userId = user(t.user);
        if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) continue;
        if (store.list('timeOff', (x) => x.userId === userId && !['cancelled', 'denied'].includes(x.status) && x.startDate <= t.date && x.endDate >= t.date).length) continue;
        store.insert('timeOff', { id: uid('tof'), userId, startDate: t.date, endDate: t.date, reason: 'Imported: request off', status: 'approved', decidedBy: actor.id, decidedAt: at, createdAt: at });
        out.timeOff++;
      }

      if ((a.events || []).length) needEvents(actor);
      for (const e of a.events || []) {
        const name = String(e.name || '').trim();
        if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) continue;
        if (store.list('events', (x) => x.date === e.date && String(x.name).trim().toLowerCase() === name.toLowerCase()).length) continue;
        store.insert('events', { id: uid('evt'), name, date: e.date, start: e.start || '', end: '', room: e.room || '', guestCount: Number(e.guestCount) || 0, type: e.type || '',
          status: 'confirmed', staffing: [], menu: [], specialDrinks: [], timeline: [], notes: String(e.notes || ''), createdAt: at, createdBy: actor.id, updatedAt: at, updatedBy: actor.id });
        out.events++;
      }

      for (const c of a.covers || []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date || '')) continue;
        const doc = { id: c.date, date: c.date, covers: Math.max(0, Number(c.covers) || 0), sales: null, source: 'import' };
        if (store.get('forecastOverrides', c.date)) store.update('forecastOverrides', c.date, doc); else store.insert('forecastOverrides', doc);
        out.covers++;
      }
      return out;
    },
    'shifts.copyWeek': (actor, { fromWeek, toWeek, replace }) => {
      needMgr(actor);
      const offset = daysBetween(fromWeek, toWeek);
      const src = store.list('shifts', (s) => s.date >= fromWeek && s.date <= addDays(fromWeek, 6) && !s.eventId);
      let removed = 0;
      store.transaction(() => {
        if (replace) {
          for (const s of store.list('shifts', (s) => s.date >= toWeek && s.date <= addDays(toWeek, 6) && !s.published && !s.eventId)) { store.remove('shifts', s.id); removed++; }
        }
        for (const s of src) {
          const { id, published, createdAt, ...rest } = s;
          store.insert('shifts', { ...rest, id: uid('shf'), date: addDays(s.date, offset), published: false, createdAt: now().toISOString(), createdBy: actor.id });
        }
      });
      return { copied: src.length, removed };
    },
    'shifts.clearDrafts': (actor, { weekStart: ws }) => {
      needMgr(actor);
      const drafts = store.list('shifts', (s) => s.date >= ws && s.date <= addDays(ws, 6) && !s.published);
      store.transaction(() => drafts.forEach((s) => store.remove('shifts', s.id)));
      return { removed: drafts.length };
    },
    'shifts.publish': (actor, { start, end, eventId }) => {
      needMgr(actor);
      const drafts = store.list('shifts', (s) => !s.published && (eventId ? s.eventId === eventId : s.date >= start && s.date <= end));
      store.transaction(() => drafts.forEach((s) => store.update('shifts', s.id, { published: true, publishedAt: now().toISOString() })));
      const byUser = new Set(drafts.map((s) => s.userId).filter(Boolean));
      const label = eventId ? `Event shifts posted for ${store.get('events', eventId)?.name}` : `The schedule for ${prettyDate(start, { dow: false })} – ${prettyDate(end, { dow: false })} is posted`;
      notify([...byUser], `${label}. Check your shifts.`, '#/my');
      const open = drafts.filter((s) => !s.userId);
      if (open.length) {
        const jobs = new Set(open.map((s) => s.jobCodeId));
        const eligible = users().filter((u) => u.active !== false && u.jobCodes?.some((j) => jobs.has(j.jobCodeId)) && !byUser.has(u.id)).map((u) => u.id);
        notify(eligible, `${open.length} open shift${open.length > 1 ? 's' : ''} available to pick up.`, '#/my');
      }
      return { published: drafts.length, notified: byUser.size };
    },
    'shifts.eligible': (actor, { shiftId }) => {
      needAuth(actor);
      const s = store.get('shifts', shiftId);
      if (!s || !visibleShift(actor, s)) fail(404, 'Shift not found');
      return users().filter((u) => u.active !== false && u.id !== s.userId && qualified(u, s.jobCodeId))
        .map((u) => ({ id: u.id, name: u.name, conflicts: conflictsFor(u.id, s) }))
        .sort((a, b) => a.conflicts.length - b.conflicts.length || a.name.localeCompare(b.name));
    },

    // ----- swaps / drops / pickups -----
    'swaps.list': (actor) => {
      needAuth(actor);
      const me = userById(actor.id);
      const all = store.list('requests').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      const recentCut = addDays(today(), -30);
      const view = all.filter((r) => (r.createdAt || '').slice(0, 10) >= recentCut || ['open', 'pending_approval'].includes(r.status));
      const approvals = isApprover(actor) ? view.filter((r) => r.status === 'pending_approval').map(requestView) : [];
      const mine = view.filter((r) => r.requesterId === actor.id || r.pickupUserId === actor.id || r.targetUserId === actor.id).map(requestView);
      const offers = view.filter((r) => r.status === 'open' && r.requesterId !== actor.id && (
        (r.type === 'swap' && r.targetUserId === actor.id) ||
        (r.type === 'drop' && qualified(me, store.get('shifts', r.shiftId)?.jobCodeId)))).map((r) => {
        const v = requestView(r);
        v.myConflicts = r.type === 'drop' ? conflictsFor(actor.id, v.shift) : conflictsFor(actor.id, v.shift, [r.targetShiftId]);
        return v;
      });
      const history = isApprover(actor) ? view.filter((r) => !['open', 'pending_approval'].includes(r.status)).slice(0, 40).map(requestView) : [];
      const openPending = isApprover(actor) ? view.filter((r) => r.status === 'open').map(requestView) : [];
      return { approvals, mine, offers, history, openPending };
    },
    'swaps.create': (actor, { shiftId, type, targetShiftId, note }) => {
      needAuth(actor);
      const st = settings();
      const s = store.get('shifts', shiftId);
      if (!s || !s.published) fail(404, 'Shift not found');
      if (!isFuture(s)) fail(400, 'That shift has already started');
      const [startAbs] = shiftSpan(s);
      const n = now();
      const nowAbs = daysBetween('2000-01-01', todayStr(n)) * 1440 + n.getHours() * 60 + n.getMinutes();
      if (st.minSwapNoticeHours && (startAbs - nowAbs) / 60 < st.minSwapNoticeHours && !isMgr(actor)) fail(400, `Swaps need at least ${st.minSwapNoticeHours} hours notice — call your manager`);
      const active = store.list('requests', (r) => ['open', 'pending_approval'].includes(r.status) && (r.shiftId === shiftId || r.targetShiftId === shiftId) && r.type !== 'pickup');
      if (active.length) fail(409, 'There is already an active request on this shift');
      const base = { id: uid('req'), shiftId, requesterId: actor.id, note: (note || '').trim(), createdAt: now().toISOString() };

      if (type === 'pickup') {
        if (s.userId) fail(400, 'That shift is not open');
        if (!qualified(userById(actor.id), s.jobCodeId)) fail(403, `You aren't set up as ${jobName(s.jobCodeId)}`);
        if (store.list('requests', (r) => r.type === 'pickup' && r.shiftId === shiftId && r.pickupUserId === actor.id && r.status === 'pending_approval').length) fail(409, 'You already requested this shift');
        const r = { ...base, type: 'pickup', pickupUserId: actor.id, status: 'pending_approval' };
        if (!st.requirePickupApproval) {
          const c = conflictsFor(actor.id, s).filter((w) => !w.startsWith('Overtime'));
          if (c.length) fail(409, c.join('; '));
          store.insert('requests', { ...r, status: 'approved', resolvedAt: now().toISOString(), resolution: 'Auto-approved' });
          executeRequest(r);
          return { ok: true, autoApproved: true };
        }
        store.insert('requests', r);
        notify(approvers().map((m) => m.id), `${nameOf(actor.id)} wants to pick up ${describe(s)}`, '#/swaps');
        return r;
      }
      if (s.userId !== actor.id) fail(403, 'You can only trade your own shifts');
      if (type === 'drop') {
        const r = store.insert('requests', { ...base, type: 'drop', status: 'open' });
        const eligible = users().filter((u) => u.id !== actor.id && u.active !== false && qualified(u, s.jobCodeId)).map((u) => u.id);
        notify(eligible, `${nameOf(actor.id)} is giving away ${describe(s)} — pick it up?`, '#/swaps');
        return r;
      }
      if (type === 'swap') {
        const t = store.get('shifts', targetShiftId);
        if (!t || !t.published || !t.userId) fail(404, 'Pick a coworker shift to trade for');
        if (t.userId === actor.id) fail(400, 'That is your own shift');
        if (!isFuture(t)) fail(400, 'That shift has already started');
        if (!qualified(userById(t.userId), s.jobCodeId)) fail(400, `${nameOf(t.userId)} isn't trained as ${jobName(s.jobCodeId)}`);
        if (!qualified(userById(actor.id), t.jobCodeId)) fail(400, `You aren't trained as ${jobName(t.jobCodeId)}`);
        const r = store.insert('requests', { ...base, type: 'swap', targetShiftId, targetUserId: t.userId, status: 'open' });
        notify([t.userId], `${nameOf(actor.id)} wants to trade their ${describe(s)} for your ${describe(t)}`, '#/swaps');
        return r;
      }
      fail(400, 'Unknown request type');
    },
    'swaps.accept': (actor, { requestId }) => {
      needAuth(actor);
      const st = settings();
      const r = store.get('requests', requestId);
      if (!r || r.status !== 'open') fail(409, 'This request is no longer open');
      const s = store.get('shifts', r.shiftId);
      let patch;
      if (r.type === 'drop') {
        if (r.requesterId === actor.id) fail(400, "You can't pick up your own shift");
        if (!qualified(userById(actor.id), s.jobCodeId)) fail(403, `You aren't set up as ${jobName(s.jobCodeId)}`);
        const hard = conflictsFor(actor.id, s).filter((w) => w.startsWith('Overlaps'));
        if (hard.length) fail(409, hard.join('; '));
        patch = { pickupUserId: actor.id };
      } else if (r.type === 'swap') {
        if (r.targetUserId !== actor.id) fail(403, 'This trade was offered to someone else');
        patch = {};
      } else fail(400, 'Nothing to accept');
      patch.acceptedAt = now().toISOString();
      const updated = { ...r, ...patch };
      if (!st.requireSwapApproval) {
        executeRequest(updated);
        store.update('requests', r.id, { ...patch, status: 'approved', resolvedAt: now().toISOString(), resolution: 'Auto-approved' });
        notify([r.requesterId], `${nameOf(actor.id)} took your ${describe(s)}. It's official.`, '#/my');
        return { ok: true, autoApproved: true };
      }
      store.update('requests', r.id, { ...patch, status: 'pending_approval' });
      notify([r.requesterId], `${nameOf(actor.id)} accepted your ${r.type === 'swap' ? 'trade' : 'shift'} — waiting on manager approval.`, '#/swaps');
      notify(approvers().map((m) => m.id).filter((id) => ![r.requesterId, actor.id].includes(id) || isMgr(userById(id))), `Approval needed: ${r.type === 'swap' ? 'trade' : 'giveaway'} of ${describe(s)} (${nameOf(r.requesterId)} → ${nameOf(actor.id)})`, '#/swaps');
      return { ok: true };
    },
    'swaps.decline': (actor, { requestId }) => {
      needAuth(actor);
      const r = store.get('requests', requestId);
      if (!r || r.status !== 'open' || r.type !== 'swap' || r.targetUserId !== actor.id) fail(409, 'Nothing to decline');
      store.update('requests', r.id, { status: 'declined', resolvedAt: now().toISOString() });
      notify([r.requesterId], `${nameOf(actor.id)} declined your trade request.`, '#/swaps');
      return { ok: true };
    },
    'swaps.cancel': (actor, { requestId }) => {
      needAuth(actor);
      const r = store.get('requests', requestId);
      if (!r || !['open', 'pending_approval'].includes(r.status)) fail(409, 'Request is already closed');
      if (r.requesterId !== actor.id && !isApprover(actor)) fail(403, 'Not your request');
      store.update('requests', r.id, { status: 'cancelled', resolvedAt: now().toISOString() });
      if (r.status === 'pending_approval') notify([r.pickupUserId, r.targetUserId].filter((id) => id !== r.requesterId), `${nameOf(r.requesterId)} cancelled the request.`, '#/swaps');
      return { ok: true };
    },
    'swaps.approve': (actor, { requestId, note }) => {
      needApprover(actor);
      const r = store.get('requests', requestId);
      if (!r || r.status !== 'pending_approval') fail(409, 'Request is not waiting on approval');
      notOwnRequest(actor, [r.requesterId, r.pickupUserId, r.targetUserId]);
      const s = store.get('shifts', r.shiftId);
      store.transaction(() => {
        executeRequest(r);
        store.update('requests', r.id, { status: 'approved', resolvedAt: now().toISOString(), resolvedBy: actor.id, resolution: note || '' });
      });
      const parties = [r.requesterId, r.pickupUserId, r.targetUserId];
      notify(parties, `Approved: ${r.type === 'swap' ? 'trade' : r.type === 'pickup' ? 'pickup' : 'giveaway'} of ${describe(s)}. Check your updated schedule.`, '#/my');
      return { ok: true };
    },
    'swaps.deny': (actor, { requestId, note }) => {
      needApprover(actor);
      const r = store.get('requests', requestId);
      if (!r || r.status !== 'pending_approval') fail(409, 'Request is not waiting on approval');
      notOwnRequest(actor, [r.requesterId, r.pickupUserId, r.targetUserId]);
      store.update('requests', r.id, { status: 'denied', resolvedAt: now().toISOString(), resolvedBy: actor.id, resolution: note || '' });
      const s = store.get('shifts', r.shiftId);
      notify([r.requesterId, r.pickupUserId, r.targetUserId], `Denied: request for ${describe(s)}${note ? ` — ${note}` : ''}`, '#/swaps');
      return { ok: true };
    },

    // ----- time off -----
    'timeOff.list': (actor) => {
      needAuth(actor);
      const rows = store.list('timeOff', (t) => isApprover(actor) || t.userId === actor.id).sort((a, b) => b.startDate.localeCompare(a.startDate));
      return rows.filter((t) => t.endDate >= addDays(today(), -60));
    },
    'timeOff.create': (actor, a) => {
      needAuth(actor);
      const userId = isMgr(actor) && a.userId ? a.userId : actor.id;
      if (!a.startDate) fail(400, 'Start date required');
      const endDate = a.endDate && a.endDate >= a.startDate ? a.endDate : a.startDate;
      const status = isMgr(actor) && a.userId && a.userId !== actor.id ? 'approved' : 'pending';
      const t = store.insert('timeOff', { id: uid('tof'), userId, startDate: a.startDate, endDate, reason: (a.reason || '').trim(), status, createdAt: now().toISOString() });
      if (status === 'pending') notify(approvers().map((m) => m.id).filter((id) => id !== userId || isMgr(userById(id))), `${nameOf(userId)} requested off ${prettyDate(t.startDate)}${endDate !== t.startDate ? ' – ' + prettyDate(endDate) : ''}`, '#/timeoff');
      const clashes = store.list('shifts', (s) => s.userId === userId && s.date >= t.startDate && s.date <= endDate);
      return { ...t, clashes: clashes.length };
    },
    'timeOff.decide': (actor, { id, status, note }) => {
      needApprover(actor);
      if (!['approved', 'denied'].includes(status)) fail(400, 'Invalid status');
      const cur = store.get('timeOff', id);
      if (!cur) fail(404, 'Not found');
      notOwnRequest(actor, [cur.userId]);
      const t = store.update('timeOff', id, { status, decidedBy: actor.id, decidedAt: now().toISOString(), note: note || '' });
      notify([t.userId], `Time off ${prettyDate(t.startDate)}${t.endDate !== t.startDate ? ' – ' + prettyDate(t.endDate) : ''} was ${status}.`, '#/timeoff');
      return t;
    },
    'timeOff.cancel': (actor, { id }) => {
      needAuth(actor);
      const t = store.get('timeOff', id);
      if (!t) fail(404, 'Not found');
      if (t.userId !== actor.id && !isApprover(actor)) fail(403, 'Not yours');
      return store.update('timeOff', id, { status: 'cancelled' });
    },

    // ----- sales & forecast -----
    'sales.list': (actor, { start, end }) => {
      needMgr(actor);
      return store.list('sales', (r) => r.date >= start && r.date <= end).sort((a, b) => a.date.localeCompare(b.date));
    },
    'sales.upsert': (actor, { rows }) => {
      needMgr(actor);
      let n = 0;
      store.transaction(() => {
        for (const r of rows || []) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
          const doc = { id: r.date, date: r.date, sales: Number(r.sales) || 0, covers: Number(r.covers) || 0, notes: r.notes || '' };
          store.get('sales', r.date) ? store.update('sales', r.date, doc) : store.insert('sales', doc);
          n++;
        }
      });
      return { saved: n };
    },
    'forecast.week': (actor, { weekStart: ws }) => {
      needMgr(actor);
      return computeForecastWeek(ws);
    },
    'forecast.summary': (actor, { weekStart: ws }) => {
      needMgr(actor);
      const f = computeForecastWeek(ws);
      return { days: f.days.map((d) => ({ date: d.date, covers: d.covers, totalCovers: d.totalCovers, sales: d.totalSales, laborPct: d.laborPct, laborCost: d.laborCost, hours: d.hours, closed: d.closed })), totals: f.totals, targetLaborPct: f.targetLaborPct };
    },
    'forecast.override': (actor, { date, covers, sales, clear }) => {
      needMgr(actor);
      if (clear) { store.remove('forecastOverrides', date); return { ok: true }; }
      const doc = { id: date, date, covers: Number(covers) || 0, sales: Number(sales) || 0 };
      return store.get('forecastOverrides', date) ? store.update('forecastOverrides', date, doc) : store.insert('forecastOverrides', doc);
    },
    'forecast.fillGaps': (actor, { weekStart: ws }) => {
      needMgr(actor);
      const f = computeForecastWeek(ws);
      const toCreate = [];
      for (const d of f.days) for (const dp of d.dayparts) for (const row of dp.rows) {
        for (let i = 0; i < row.gap; i++) toCreate.push({ date: d.date, start: dp.start, end: dp.end, jobCodeId: row.jobCodeId, userId: null, notes: `Forecast: ${dp.name} (${dp.covers} covers)` });
      }
      store.transaction(() => toCreate.forEach((s) => store.insert('shifts', { id: uid('shf'), ...cleanShift(s), published: false, createdAt: now().toISOString(), createdBy: actor.id })));
      return { created: toCreate.length };
    },

    // ----- events / BEOs -----
    'events.list': (actor, { start, end } = {}) => {
      needAuth(actor);
      const from = start || addDays(today(), -7);
      return store.list('events', (e) => e.date >= from && (!end || e.date <= end) && (isEvents(actor) || e.status !== 'tentative'))
        .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
        .map((e) => { const v = eventView(e, actor); return { id: v.id, name: v.name, date: v.date, start: v.start, end: v.end, room: v.room, guestCount: v.guestCount, status: v.status, type: v.type, needed: v.needed, filled: v.filled, captainId: v.captainId, client: v.client }; });
    },
    'events.get': (actor, { id }) => {
      needAuth(actor);
      const e = store.get('events', id);
      if (!e || (!isEvents(actor) && e.status === 'tentative')) fail(404, 'Event not found');
      const v = eventView(e, actor);
      if (!isEvents(actor)) { delete v.estRevenue; delete v.contactPhone; delete v.contactEmail; delete v.deposit; }
      v.comments = store.list('eventComments', (c) => c.eventId === id).sort((a, b) => a.at.localeCompare(b.at)).map((c) => ({ ...c, userName: nameOf(c.userId) }));
      return v;
    },
    'events.save': (actor, a) => {
      needEvents(actor);
      if (!a.name?.trim()) fail(400, 'Event name is required');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) fail(400, 'Event date is required');
      const fields = ['name', 'date', 'start', 'end', 'room', 'guestCount', 'guaranteed', 'type', 'serviceStyle', 'status', 'client', 'contactName', 'contactPhone', 'contactEmail',
        'estRevenue', 'deposit', 'captainId', 'menu', 'beverage', 'specialDrinks', 'staffing', 'timeline', 'setupNotes', 'dietaryNotes', 'avNotes', 'attire', 'notes'];
      const doc = {};
      for (const f of fields) if (f in a) doc[f] = a[f];
      doc.guestCount = Number(doc.guestCount) || 0;
      doc.staffing = (doc.staffing || []).map((l) => ({ id: l.id || uid('stf'), jobCodeId: l.jobCodeId, count: Number(l.count) || 0, start: l.start || a.start, end: l.end || a.end || '', notes: l.notes || '' }));
      doc.updatedAt = now().toISOString();
      doc.updatedBy = actor.id;
      let e;
      if (a.id) {
        const cur = store.get('events', a.id);
        if (!cur) fail(404, 'Event not found');
        e = store.update('events', a.id, doc);
        const staff = store.list('shifts', (s) => s.eventId === a.id && s.userId && s.published).map((s) => s.userId);
        notify([...staff, e.captainId].filter((id) => id !== actor.id), `BEO updated: ${e.name} (${prettyDate(e.date)}). Review the latest details.`, `#/events/${e.id}`);
      } else {
        e = store.insert('events', { id: uid('evt'), status: 'tentative', ...doc, createdAt: now().toISOString(), createdBy: actor.id });
        notify(managers().map((m) => m.id).filter((id) => id !== actor.id), `New event: ${e.name} on ${prettyDate(e.date)} — ${e.guestCount} guests`, `#/events/${e.id}`);
      }
      return eventView(e, actor);
    },
    'events.delete': (actor, { id }) => {
      needEvents(actor);
      const linked = store.list('shifts', (s) => s.eventId === id);
      store.transaction(() => {
        for (const s of linked) { cancelRequestsForShift(s.id, 'the event was removed'); store.remove('shifts', s.id); }
        store.remove('events', id);
      });
      notify(linked.filter((s) => s.published && s.userId).map((s) => s.userId), 'An event you were scheduled for was cancelled.', '#/my');
      return { ok: true };
    },
    'events.suggestStaffing': (actor, event) => {
      needEvents(actor);
      return suggestStaffing(event, store.list('jobCodes'));
    },
    'events.generateShifts': (actor, { id, publish }) => {
      needMgr(actor);
      const e = store.get('events', id);
      if (!e) fail(404, 'Event not found');
      let created = 0;
      store.transaction(() => {
        for (const line of e.staffing || []) {
          const existing = store.list('shifts', (s) => s.eventId === id && s.staffingLineId === line.id);
          for (let i = existing.length; i < line.count; i++) {
            const isCaptainLine = /captain/i.test(jobName(line.jobCodeId));
            const assign = isCaptainLine && i === 0 && e.captainId && qualified(userById(e.captainId), line.jobCodeId) ? e.captainId : null;
            store.insert('shifts', { id: uid('shf'), ...cleanShift({ date: e.date, start: line.start || e.start, end: line.end || null, jobCodeId: line.jobCodeId, userId: assign, tag: e.room ? e.room.split(' ').map((w) => w[0]).join('').toUpperCase() : 'EVT', notes: `${e.name}${line.notes ? ' — ' + line.notes : ''}`, eventId: id, staffingLineId: line.id }), published: !!publish, createdAt: now().toISOString(), createdBy: actor.id });
            created++;
          }
        }
      });
      if (publish && created) api['shifts.publish'](actor, { eventId: id });
      return { created };
    },
    'events.comment': (actor, { eventId, text }) => {
      needAuth(actor);
      if (!text?.trim()) fail(400, 'Write something first');
      const e = store.get('events', eventId);
      if (!e) fail(404, 'Event not found');
      const c = store.insert('eventComments', { id: uid('cmt'), eventId, userId: actor.id, text: text.trim(), at: now().toISOString() });
      const staff = store.list('shifts', (s) => s.eventId === eventId && s.userId && s.published).map((s) => s.userId);
      const others = store.list('eventComments', (x) => x.eventId === eventId).map((x) => x.userId);
      const evTeam = users().filter((u) => u.active !== false && canManageEvents(u)).map((u) => u.id);
      notify([...new Set([...staff, ...others, ...evTeam, e.captainId])].filter((id) => id && id !== actor.id), `${nameOf(actor.id)} on ${e.name}: “${text.trim().slice(0, 80)}”`, `#/events/${eventId}`);
      return { ...c, userName: nameOf(actor.id) };
    },

    // ----- venue: locations, levels, rooms and floor plans -----
    // A one-room restaurant needs none of this; the UI offers a one-click start from settings.rooms.
    // Room names are mirrored into settings.rooms, which events and the schedule importer use.
    ...(() => {
      const ITEM_TYPES = ['table-round', 'table-square', 'table-rect', 'booth', 'bar', 'stage', 'dancefloor', 'dj', 'host', 'wall', 'door', 'plant', 'label'];
      const SEATED = new Set(['table-round', 'table-square', 'table-rect', 'booth', 'bar']);
      const KINDS = ['dining', 'bar', 'events', 'other'];
      const BOOKING_TYPES = /full buyout/i; // in settings.rooms but not a physical space
      const num = (v, d) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : d);
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name));
      const emptyPlan = () => ({ width: 1000, height: 700, items: [] });

      function cleanPlan(p) {
        const width = clamp(Math.round(num(p?.width, 1000)), 200, 5000);
        const height = clamp(Math.round(num(p?.height, 700)), 200, 5000);
        const raw = Array.isArray(p?.items) ? p.items : [];
        if (raw.length > 500) fail(400, 'A floor plan can have at most 500 items');
        const ids = new Set();
        const items = raw.map((i) => {
          if (!ITEM_TYPES.includes(i?.type)) fail(400, `Unknown floor plan item "${text(i?.type, 30)}"`);
          const w = clamp(Math.round(num(i.w, 60)), 4, width);
          const h = clamp(Math.round(num(i.h, 60)), 4, height);
          let id = text(i.id, 40);
          if (!id || ids.has(id)) id = uid('itm');
          ids.add(id);
          return {
            id, type: i.type, w, h,
            x: clamp(Math.round(num(i.x, 0)), 0, width - w),
            y: clamp(Math.round(num(i.y, 0)), 0, height - h),
            r: ((Math.round(num(i.r, 0)) % 360) + 360) % 360,
            label: text(i.label, 40),
            seats: SEATED.has(i.type) ? clamp(Math.round(num(i.seats, 0)), 0, 40) : 0,
          };
        });
        return { width, height, items };
      }

      function syncRoomNames() {
        const rooms = store.list('rooms');
        const order = new Map(store.list('locations').map((l) => [l.id, l.order ?? 0]));
        rooms.sort((a, b) => (order.get(a.locationId) ?? 0) - (order.get(b.locationId) ?? 0) || byOrder(a, b));
        const names = [...new Set(rooms.map((r) => r.name))];
        const keep = (settings().rooms || []).filter((r) => BOOKING_TYPES.test(r) && !names.some((n) => n.toLowerCase() === r.toLowerCase()));
        const next = [...names, ...keep];
        if (store.get('settings', 'settings')) store.update('settings', 'settings', { rooms: next });
        else store.insert('settings', { ...DEFAULT_SETTINGS, rooms: next });
      }

      function defaultLocation() {
        const first = store.list('locations').sort(byOrder)[0];
        return first || store.insert('locations', { id: uid('loc'), name: settings().restaurantName || 'Main location', address: '', order: 0 });
      }

      const view = () => ({
        locations: store.list('locations').sort(byOrder),
        rooms: store.list('rooms').sort(byOrder),
        itemTypes: ITEM_TYPES,
        kinds: KINDS,
      });

      return {
        'venue.get': (actor) => {
          needAuth(actor);
          return view();
        },
        'venue.setup': (actor) => {
          needMgr(actor);
          if (store.list('locations').length || store.list('rooms').length) fail(409, 'The venue is already set up');
          const loc = defaultLocation();
          let order = 0;
          for (const name of settings().rooms || []) {
            if (/buyout/i.test(name)) continue;
            const kinds = /\bbar\b|lounge|pub|rabbit hole/i.test(name) ? ['bar'] : ['dining'];
            store.insert('rooms', { id: uid('room'), locationId: loc.id, level: 'Main floor', name: text(name, 60), kinds, capacity: 0, order: order++, plan: emptyPlan() });
          }
          syncRoomNames();
          return view();
        },
        'venue.saveLocation': (actor, a) => {
          needMgr(actor);
          const name = text(a.name, 80);
          if (!name) fail(400, 'Location name is required');
          const doc = { name, address: text(a.address, 200), order: num(a.order, store.list('locations').length) };
          if (a.id) {
            if (!store.get('locations', a.id)) fail(404, 'Location not found');
            const out = store.update('locations', a.id, doc);
            syncRoomNames();
            return out;
          }
          return store.insert('locations', { id: uid('loc'), ...doc });
        },
        'venue.deleteLocation': (actor, { id }) => {
          needMgr(actor);
          if (!store.get('locations', id)) fail(404, 'Location not found');
          const n = store.list('rooms', (r) => r.locationId === id).length;
          if (n) fail(409, `Move or delete its ${n} room${n === 1 ? '' : 's'} first`);
          store.remove('locations', id);
          return { ok: true };
        },
        'venue.saveRoom': (actor, a) => {
          needMgr(actor);
          const cur = a.id ? store.get('rooms', a.id) : null;
          if (a.id && !cur) fail(404, 'Room not found');
          const locationId = a.locationId || cur?.locationId || defaultLocation().id;
          if (!store.get('locations', locationId)) fail(404, 'Location not found');
          const name = text(a.name ?? cur?.name, 60);
          if (!name) fail(400, 'Room name is required');
          if (store.list('rooms', (r) => r.locationId === locationId && r.id !== a.id && r.name.toLowerCase() === name.toLowerCase()).length) {
            fail(400, `There's already a room called ${name} here`);
          }
          const kinds = [...new Set((Array.isArray(a.kinds) ? a.kinds : cur?.kinds || ['dining']).filter((k) => KINDS.includes(k)))];
          const doc = {
            locationId, name, kinds,
            level: text(a.level ?? cur?.level, 40) || 'Main floor',
            capacity: clamp(Math.round(num(a.capacity ?? cur?.capacity, 0)), 0, 100000),
            order: num(a.order ?? cur?.order, store.list('rooms').length),
          };
          const out = cur ? store.update('rooms', cur.id, doc) : store.insert('rooms', { id: uid('room'), ...doc, plan: emptyPlan() });
          syncRoomNames();
          return out;
        },
        'venue.deleteRoom': (actor, { id }) => {
          needMgr(actor);
          if (!store.remove('rooms', id)) fail(404, 'Room not found');
          syncRoomNames();
          return { ok: true };
        },
        'venue.reorderRooms': (actor, { ids }) => {
          needMgr(actor);
          (Array.isArray(ids) ? ids : []).forEach((id, i) => { if (store.get('rooms', id)) store.update('rooms', id, { order: i }); });
          syncRoomNames();
          return view();
        },
        'venue.renameLevel': (actor, { locationId, from, to }) => {
          needMgr(actor);
          const name = text(to, 40);
          if (!name) fail(400, 'Level name is required');
          const rooms = store.list('rooms', (r) => r.locationId === locationId && r.level === from);
          for (const r of rooms) store.update('rooms', r.id, { level: name });
          return { renamed: rooms.length };
        },
        'venue.savePlan': (actor, { roomId, plan }) => {
          needMgr(actor);
          if (!store.get('rooms', roomId)) fail(404, 'Room not found');
          return store.update('rooms', roomId, { plan: cleanPlan(plan) });
        },
      };
    })(),

    // ----- notifications -----
    'notifications.list': (actor) => {
      needAuth(actor);
      return store.list('notifications', (n) => n.userId === actor.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
    },
    'notifications.readAll': (actor) => {
      needAuth(actor);
      store.transaction(() => store.list('notifications', (n) => n.userId === actor.id && !n.read).forEach((n) => store.update('notifications', n.id, { read: true })));
      return { ok: true };
    },
  };

  return {
    api,
    call(actor, method, args = {}) {
      const fn = api[method];
      if (!fn) fail(404, `Unknown method ${method}`);
      return fn(actor, args || {});
    },
    settings,
  };
}
