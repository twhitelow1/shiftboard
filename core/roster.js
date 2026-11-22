// Who is listed in each schedule section (an area + a position, e.g. Servers under RESTAURANT), and
// in what order. Someone shows in a section when their job code lists that area (or, with no areas,
// when the section is the job's department) or when they have a shift there that week. These
// methods let a manager add someone to a section, take them off it (optionally moving their shifts
// there to another section), and set the order of names on the sheet.
import { findArea, sameArea, scheduleAreas, cleanArea } from './areas.js';
import { canManageUser } from './roles.js';

export function rosterApi({ store, settings, fail, needMgr, today }) {
  const areaList = () => scheduleAreas(settings());
  const canon = (a) => (a ? findArea(a, areaList()) || cleanArea(a) : '');
  const jobOf = (id) => {
    const j = store.get('jobCodes', id);
    if (!j) fail(404, 'That position doesn’t exist');
    return j;
  };
  const personOf = (actor, id) => {
    const u = store.get('users', id);
    if (!u) fail(404, 'That person doesn’t exist');
    if (u.id !== actor.id && !canManageUser(actor, u)) fail(403, 'Only a higher role can change this person’s positions');
    return u;
  };
  // A section is its job plus the banner it shows under: the area, or the job's department.
  const sectionOf = (job, area) => canon(area) || canon(job.department) || '';
  const shiftSection = (sh, job) => canon(sh.area) || canon(job.department) || '';
  const sameSection = (a, b) => (a || b ? sameArea(a, b) : true);
  const entryListsSection = (entry, job, section) => (entry.areas?.length
    ? entry.areas.some((a) => sameSection(canon(a), section))
    : sameSection(canon(job.department), section));

  // What taking someone off a section would do: their job code, and their shifts there from `from` on.
  function plan(actor, { userId, jobCodeId, area = '', from }) {
    const u = personOf(actor, userId);
    const job = jobOf(jobCodeId);
    const section = sectionOf(job, area);
    const entry = (u.jobCodes || []).find((e) => e.jobCodeId === job.id);
    let keepsAreas = [], removesJob = false;
    if (entry && entryListsSection(entry, job, section)) {
      keepsAreas = (entry.areas || []).filter((a) => !sameSection(canon(a), section));
      removesJob = !keepsAreas.length;
    }
    const since = from || today();
    const shifts = store.list('shifts', (s) => s.userId === u.id && s.jobCodeId === job.id && s.date >= since
      && sameSection(shiftSection(s, job), section));
    return { u, job, section, entry, keepsAreas, removesJob, shifts };
  }

  const label = (jobId, area) => {
    const j = store.get('jobCodes', jobId);
    return j ? `${j.name}${area ? ` · ${area}` : ''}` : '';
  };

  return {
    /** Before taking someone off: what happens to their job code, their shifts there, and where else they work. */
    'roster.get': (actor, a = {}) => {
      needMgr(actor);
      const p = plan(actor, a);
      // Where their shifts could go instead: their other positions and areas (e.g. Cocktail Server · Moon Rabbit).
      const targets = [];
      for (const e of p.u.jobCodes || []) {
        const j = store.get('jobCodes', e.jobCodeId);
        if (!j || j.archived) continue;
        for (const ar of e.areas?.length ? e.areas : ['']) {
          const sec = canon(ar);
          if (j.id === p.job.id && sameSection(sec || canon(j.department), p.section)) continue;
          targets.push({ jobCodeId: j.id, area: sec, label: label(j.id, sec || canon(j.department)) });
        }
      }
      return { removesJob: p.removesJob, keepsAreas: p.keepsAreas, listed: !!p.entry && entryListsSection(p.entry, p.job, p.section), shifts: p.shifts.length, targets };
    },

    /** List someone in a section: give them the position there (adding the job code if they don't have it). */
    'roster.add': (actor, { userId, jobCodeId, area = '' } = {}) => {
      needMgr(actor);
      const u = personOf(actor, userId);
      const job = jobOf(jobCodeId);
      if (job.archived) fail(400, 'That position is archived');
      const section = sectionOf(job, area);
      const areaHere = canon(area);
      const jobCodes = [...(u.jobCodes || [])];
      const i = jobCodes.findIndex((e) => e.jobCodeId === job.id);
      if (i < 0) {
        jobCodes.push({ jobCodeId: job.id, rate: null, primary: !jobCodes.length, ...(areaHere ? { areas: [areaHere] } : {}) });
      } else if (!entryListsSection(jobCodes[i], job, section)) {
        const e = jobCodes[i];
        // With no areas the person shows under the job's department; keep that and add this area.
        const before = e.areas?.length ? e.areas : (canon(job.department) ? [canon(job.department)] : []);
        jobCodes[i] = { ...e, areas: [...before, areaHere || canon(job.department)].filter(Boolean) };
      } else {
        return { ok: true, already: true };
      }
      store.update('users', u.id, { jobCodes });
      return { ok: true };
    },

    /**
     * Take someone off a section. Their job code loses this area (or goes, if this was its only place).
     * Their shifts there from `from` on stay as they are (shifts: 'keep') or move to another section
     * (shifts: 'move', moveTo: { jobCodeId, area }), so they stop showing here.
     */
    'roster.remove': (actor, a = {}) => {
      needMgr(actor);
      const p = plan(actor, a);
      let moved = 0;
      if (a.shifts === 'move') {
        const to = a.moveTo || {};
        const toJob = jobOf(to.jobCodeId);
        const toArea = canon(to.area);
        if (toJob.id === p.job.id && sameSection(toArea || canon(toJob.department), p.section)) fail(400, 'Pick a different section to move the shifts to');
        for (const s of p.shifts) { store.update('shifts', s.id, { jobCodeId: toJob.id, area: toArea }); moved++; }
        // They work there now, so make sure they're listed there.
        const jobCodes = [...(store.get('users', p.u.id).jobCodes || [])];
        const i = jobCodes.findIndex((e) => e.jobCodeId === toJob.id);
        const toSection = sectionOf(toJob, toArea);
        if (i < 0) jobCodes.push({ jobCodeId: toJob.id, rate: null, primary: false, ...(toArea ? { areas: [toArea] } : {}) });
        else if (!entryListsSection(jobCodes[i], toJob, toSection)) {
          const e = jobCodes[i];
          const before = e.areas?.length ? e.areas : (canon(toJob.department) ? [canon(toJob.department)] : []);
          jobCodes[i] = { ...e, areas: [...before, toArea || canon(toJob.department)].filter(Boolean) };
        }
        store.update('users', p.u.id, { jobCodes });
      }
      // Their job code: drop this area, or the job code itself when this was its only place.
      if (p.entry && entryListsSection(p.entry, p.job, p.section)) {
        let jobCodes = [...(store.get('users', p.u.id).jobCodes || [])];
        if (p.removesJob) {
          jobCodes = jobCodes.filter((e) => e.jobCodeId !== p.job.id);
          if (p.entry.primary && jobCodes.length && !jobCodes.some((e) => e.primary)) jobCodes[0] = { ...jobCodes[0], primary: true };
        } else {
          jobCodes = jobCodes.map((e) => (e.jobCodeId === p.job.id ? { ...e, areas: p.keepsAreas } : e));
        }
        store.update('users', p.u.id, { jobCodes });
      }
      // And off the sheet's name order for this section.
      for (const r of store.list('rosters', (r) => r.jobCodeId === p.job.id && sameSection(canon(r.area) || canon(p.job.department), p.section))) {
        if ((r.userIds || []).includes(p.u.id)) store.update('rosters', r.id, { userIds: r.userIds.filter((id) => id !== p.u.id) });
      }
      return { ok: true, removedJob: p.removesJob, moved, kept: a.shifts === 'move' ? 0 : p.shifts.length };
    },

    /** The order of names in a section on the sheet. */
    'roster.order': (actor, { jobCodeId, area = '', userIds } = {}) => {
      needMgr(actor);
      const job = jobOf(jobCodeId);
      if (!Array.isArray(userIds) || userIds.length > 500) fail(400, 'Pick the order of names');
      const ids = [...new Set(userIds.filter((id) => typeof id === 'string' && store.get('users', id)))];
      const areaHere = canon(area);
      const id = `${areaHere.toLowerCase()}|${job.id}`;
      const at = new Date().toISOString();
      if (store.get('rosters', id)) store.update('rosters', id, { userIds: ids, updatedAt: at });
      else store.insert('rosters', { id, area: areaHere, jobCodeId: job.id, label: null, banner: '', userIds: ids, updatedAt: at });
      return { ok: true };
    },
  };
}
