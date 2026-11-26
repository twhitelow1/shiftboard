// Pieces the Training pages share, plus the two that live elsewhere: the manager-on-duty card (Training,
// My Shifts) and the call-out panel on your own upcoming shift (ShiftDialog). UI words are in training-strings.js.
import React, { useEffect, useState } from 'react';
import '../training.css';
import { useApp, Icon, Modal, Field, useAction } from '../ui.jsx';
import { call as rpc, IS_DEMO } from '../api.js';
import { localize, dayLabel, categoryLabel, FIELD_GROUPS } from '../../../core/training.js';
import { useI18n, fmtTime } from '../i18n/index.js';
import { parseBlocks, parseInline } from '../minimark.js';
import { STRINGS } from '../training-strings.js';

/**
 * Training's words in the app's language: the same switch as everything else (web/src/i18n). The words
 * stay in training-strings.js because many are functions; the catalog test checks it has the same keys in both.
 */
export function useT() { return STRINGS[useLang()] || STRINGS.en; }
export function useLang() { const { lang } = useI18n(); return lang === 'es' ? 'es' : 'en'; }

const PATHS = {
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3',
  cards: 'M4 7h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM6 3h14a2 2 0 0 1 2 2v12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  quiz: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
};
/** Icons Training needs beyond the app's set (ui.jsx). */
export function TIcon({ name, size = 16, style }) {
  if (!PATHS[name]) return <Icon name={name} size={size} style={style} />;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} style={style} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const dial = (phone) => String(phone || '').replace(/[^\d+]/g, '');
export const telHref = (phone) => `tel:${dial(phone)}`;
export const smsHref = (phone) => `sms:${dial(phone)}`;
/** A date for people: 'Fri, Oct 9' / 'vie 9 oct'. Takes 'YYYY-MM-DD' or an ISO time. */
export const fmtDay = (v, lang) => (v ? dayLabel(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : isoToLocalDate(v), lang) : '');
function isoToLocalDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const pct = (v) => (v == null ? '—' : `${v}%`);

// ---------- photos ----------
const demoPhotos = new Map(); // the demo has no server: photos come from the in-browser store as data URLs
/** A menu photo (id) or a quiz question's photo ({ attemptId, qKey }), only for signed-in people. */
export function Photo({ id, attemptId, qKey, alt = '', className = '', onClick }) {
  const src0 = attemptId ? `/api/training/quiz-photo/${encodeURIComponent(attemptId)}/${encodeURIComponent(qKey)}` : `/api/training/photos/${encodeURIComponent(id)}`;
  const k = attemptId ? `${attemptId}/${qKey}` : id;
  const [src, setSrc] = useState(IS_DEMO ? demoPhotos.get(k) || '' : src0);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!IS_DEMO) { setSrc(src0); return; }
    if (demoPhotos.has(k)) { setSrc(demoPhotos.get(k)); return; }
    let live = true;
    rpc(attemptId ? 'quiz.photo.get' : 'menu.photo.get', attemptId ? { attemptId, key: qKey } : { id })
      .then((r) => { demoPhotos.set(k, r.dataUrl); if (live) setSrc(r.dataUrl); }).catch(() => live && setBroken(true));
    return () => { live = false; };
  }, [k]);
  if (!src || broken) return <div className={`tr-photo-ph ${className}`} onClick={onClick}><TIcon name="camera" size={28} /></div>;
  return <img className={className} src={src} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} onClick={onClick} draggable={false} />;
}

/**
 * Shrink a photo in the browser before upload: about 1200px on the long side, WebP (or JPEG where the browser
 * can't make WebP), lowering quality and size until it's under ~480 KB. One photo per request stays far under
 * the server's request limit.
 */
export function photoFromFile(file, { max = 1200, limit = 480 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) return reject(new Error('bad'));
      let scale = Math.min(1, max / Math.max(w0, h0));
      const canvas = document.createElement('canvas');
      const bytes = (d) => Math.floor(((d.length - d.indexOf(',') - 1) * 3) / 4);
      for (let tries = 0; tries < 8; tries++) {
        const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // a transparent PNG shouldn't turn black as a JPEG
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        for (const q of [0.82, 0.72, 0.6, 0.5]) {
          let out = canvas.toDataURL('image/webp', q);
          if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', q);
          if (bytes(out) <= limit) return resolve({ dataUrl: out, w, h });
        }
        scale *= 0.8;
      }
      reject(new Error('big'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad')); };
    img.src = url;
  });
}

// ---------- formatted text (manual pages) ----------
function Inline({ text }) {
  const render = (tokens) => tokens.map((x, i) => {
    if (x.t === 'text') return <React.Fragment key={i}>{x.v}</React.Fragment>;
    if (x.t === 'b') return <strong key={i}>{render(x.c)}</strong>;
    if (x.t === 'i') return <em key={i}>{render(x.c)}</em>;
    const external = /^https?:/i.test(x.href);
    return <a key={i} href={x.href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{render(x.c)}</a>;
  });
  return render(parseInline(text));
}
/** A manual page's text with headings, lists, bold, links and notes. Never raw HTML. */
export function Markdown({ text, className = '' }) {
  return (
    <div className={`tr-md ${className}`}>
      {parseBlocks(text).map((b, i) => {
        if (b.type === 'h') { const H = `h${b.level + 1}`; return <H key={i}><Inline text={b.text} /></H>; }
        if (b.type === 'list') {
          const L = b.ordered ? 'ol' : 'ul';
          return <L key={i} {...(b.ordered && b.start !== 1 ? { start: b.start } : {})}>{b.items.map((it, k) => <li key={k}><Inline text={it} /></li>)}</L>;
        }
        const lines = b.lines.map((l, k) => <React.Fragment key={k}>{k > 0 && <br />}<Inline text={l} /></React.Fragment>);
        return b.type === 'note' ? <div key={i} className="tr-note">{lines}</div> : <p key={i}>{lines}</p>;
      })}
    </div>
  );
}

// ---------- small controls ----------
/** English | Español switch for editing both versions of what a manager writes. */
export function LangTabs({ value, onChange }) {
  const t = useT();
  return (
    <div className="seg tr-langtabs" role="tablist">
      <button type="button" className={value === 'en' ? 'on' : ''} onClick={() => onChange('en')}>{t.english}</button>
      <button type="button" className={value === 'es' ? 'on' : ''} onClick={() => onChange('es')}>{t.spanish}</button>
    </div>
  );
}
/** Toggle chips for picking several values. */
export function Chips({ options, value = [], onChange, render = (o) => o.label ?? o }) {
  const idOf = (o) => o.id ?? o;
  const set = new Set(value);
  return (
    <div className="row wrap tr-chips">
      {options.map((o) => {
        const id = idOf(o);
        return <button key={id} type="button" className={`chip ${set.has(id) ? 'on' : ''}`} aria-pressed={set.has(id)}
          onClick={() => onChange(set.has(id) ? value.filter((x) => x !== id) : [...value, id])}>{render(o)}</button>;
      })}
    </div>
  );
}

// ---------- manager on duty ----------
/** One manager's line, always with the time in: "On now · 4 pm–10 pm", "In at 4 pm today", "Earlier today · 10 am–4 pm". */
function managerLine(m, mod, t, lang) {
  const s = m.shift;
  if (!s) return m.state === 'now' ? t.todayOverride : '';
  const span = `${fmtTime(s.start)}${s.end ? `–${fmtTime(s.end)}` : ''}`;
  if (m.state === 'now') return `${t.onNow} · ${span}`;
  if (m.state === 'later') return `${t.inAt(fmtTime(s.start))}${s.end ? `–${fmtTime(s.end)}` : ''}`;
  if (m.state === 'earlier') return t.earlierToday(span);
  return `${fmtDay(mod.date, lang)} · ${span}`;
}
/**
 * Every manager on duty today, each with their shift and Call (tel:) and Text (sms:) buttons: who's on now first
 * (highlighted, the one in charge at the top), then later today, then earlier. With none on the schedule, the
 * restaurant's call-out line.
 */
export function ModCard({ compact = false, mod: given = null }) {
  const { call, version, isMgr, has } = useApp();
  const t = useT();
  const lang = useLang();
  const [mod, setMod] = useState(given);
  const [editing, setEditing] = useState(false);
  // The managers on duty are in every plan (not only with Training).
  useEffect(() => { if (!given) call('mod.get').then(setMod).catch(() => setMod(false)); }, [version, given]);
  if (!mod) return null;
  // Older servers answer with one person only.
  const list = mod.managers || (mod.person ? [{ ...mod.person, state: mod.status === 'now' || mod.status === 'override' ? 'now' : mod.status === 'next' ? 'later' : 'planned', inCharge: true }] : []);
  const anyPhone = list.some((m) => m.phone);
  return (
    <div className={`card tr-mod ${compact ? 'compact' : ''}`}>
      <div className="tr-mod-main">
        <div className="tr-mod-icon"><TIcon name="phone" size={18} /></div>
        <div className="tr-mod-who">
          <div className="tr-kicker">{list.length > 1 ? t.managersOnDuty(list.length) : t.managerOnDuty}</div>
          {!list.length && <div className="small muted">{t.noManagerNow}</div>}
        </div>
        {isMgr && !compact && <button className="btn sm ghost" onClick={() => setEditing(true)}>{t.change}</button>}
      </div>
      {list.length > 0 && (
        <ul className="tr-mod-list">
          {list.map((m) => (
            <li key={m.id} className={`tr-mod-row ${m.state === 'now' ? 'on' : ''} ${m.state === 'earlier' ? 'past' : ''}`}>
              <div className="tr-mod-person">
                <div className="tr-mod-name">{m.name}{m.inCharge && list.length > 1 && <span className="badge tr-mod-charge">{t.inCharge}</span>}</div>
                <div className="small muted">{managerLine(m, mod, t, lang)}</div>
                {m.phone && <a className="small tr-mod-phone" href={telHref(m.phone)}>{m.phone}</a>}
              </div>
              {m.phone ? (
                <div className="tr-mod-btns">
                  <a className={`btn sm ${m.state === 'now' ? 'primary' : ''}`} href={telHref(m.phone)} aria-label={t.callName(m.name)}><TIcon name="phone" size={15} />{t.call}</a>
                  <a className="btn sm" href={smsHref(m.phone)} aria-label={t.textName(m.name)}><TIcon name="message" size={15} />{t.text}</a>
                </div>
              ) : <span className="tiny faint tr-mod-nophone">{m.state === 'earlier' ? '' : t.noPhoneShort}</span>}
            </li>
          ))}
        </ul>
      )}
      {mod.callOutPhone && (
        <div className="tr-mod-actions">
          <a className={`btn ${anyPhone ? 'ghost' : ''}`} href={telHref(mod.callOutPhone)} title={mod.callOutPhone}>
            <TIcon name="phone" />{t.callOutLine}{!anyPhone && <span className="tr-mod-num">{mod.callOutPhone}</span>}
          </a>
        </div>
      )}
      {editing && <ModOverrideModal onClose={(next) => { setEditing(false); if (next) setMod(next.today); }} />}
    </div>
  );
}

function ModOverrideModal({ onClose }) {
  const { call, today, refresh } = useApp();
  const t = useT();
  const lang = useLang();
  const [date, setDate] = useState(today);
  const [day, setDay] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { call('mod.get', { date }).then(setDay); }, [date]);
  const pick = async (userId) => {
    const r = await run(() => call('mod.setOverride', { date, userId: userId || null }), t.saved);
    if (r) { setDay(r); refresh(); }
  };
  return (
    <Modal title={t.managerOnDuty} sub={t.modHelp} onClose={() => onClose(null)}
      footer={<button className="btn primary" onClick={() => onClose(null)}>{t.done}</button>}>
      <Field label={t.day}><input className="input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
      {day && <>
        <Field label={t.whoIsOnDuty}>
          <select className="input" value={day.override || ''} disabled={busy} onChange={(e) => pick(e.target.value)}>
            <option value="">{t.automatic}</option>
            {day.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <div className="small">
          <div className="tr-kicker">{t.managersScheduled(fmtDay(date, lang))}</div>
          {day.scheduled.length ? <ul className="tr-plain">{day.scheduled.map((s, i) => <li key={i}><b>{s.name}</b> · {s.jobName} · {fmtTime(s.start)}{s.end ? `–${fmtTime(s.end)}` : ` ${t.untilClose}`}</li>)}</ul>
            : <div className="muted">{t.noManagersScheduled}</div>}
        </div>
        {day.person && <div className="alert info"><TIcon name="phone" />{t.modIs(day.person.name)}</div>}
      </>}
      <ModShownList />
    </Modal>
  );
}

/** Managers and up: a switch per person for whether they show in Managers on duty (mod.visibility / mod.setShown). */
function ModShownList() {
  const { call, refresh } = useApp();
  const t = useT();
  const [list, setList] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { call('mod.visibility').then((r) => setList(r.people)).catch(() => setList([])); }, []);
  const toggle = async (p) => {
    const r = await run(() => call('mod.setShown', { userId: p.id, shown: !p.shown }), t.saved);
    if (r) { setList(r.people); refresh(); }
  };
  if (!list?.length) return null;
  return (
    <div className="tr-mod-shown">
      <div className="tr-kicker">{t.shownTitle}</div>
      <div className="small muted" style={{ marginBottom: 6 }}>{t.shownHelp}</div>
      {list.map((p) => (
        <label key={p.id} className="tr-mod-shown-row">
          <input type="checkbox" checked={p.shown} disabled={busy} onChange={() => toggle(p)} />
          <span>{p.name}</span>
        </label>
      ))}
    </div>
  );
}

/** On your own upcoming shift: the call-out procedure and buttons to reach the manager on duty. */
export function CallOutPanel() {
  const { call } = useApp();
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(undefined);
  const [mod, setMod] = useState(null);
  useEffect(() => {
    if (!open || page !== undefined) return;
    call('manual.get', { callOut: true }).then((p) => setPage(p || null)).catch(() => setPage(null));
    call('mod.get').then(setMod).catch(() => setMod(false));
  }, [open]);
  const shown = page ? localize(page, lang) : null;
  return (
    <div className={`tr-callout ${open ? 'open' : ''}`}>
      <button type="button" className="tr-callout-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <TIcon name="phone" size={18} /><span>{t.cantMakeIt}</span><Icon name={open ? 'up' : 'down'} size={16} />
      </button>
      {open && (
        <div className="tr-callout-body">
          {mod && <ModCard compact mod={mod} />}
          {page === undefined ? <div className="small muted">{t.loading}</div> : shown ? (
            <div>
              <div className="tr-kicker">{shown.title}</div>
              <Markdown text={shown.body} className="tr-callout-text" />
              <a className="small" href={`#/training/manual/${page.id}`}>{t.openInManual}</a>
            </div>
          ) : <div className="small muted">{t.noCallOutPage}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- Settings → Training ----------
/** The restaurant's Training settings (admins): leaderboard, call-out line, who sees recipes, menu sections. */
export function TrainingSettingsCard() {
  const { call } = useApp();
  const t = useT();
  const [s, setS] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { call('training.settings.get').then((r) => setS({ ...r, orderText: r.categoryOrder.join(', ') })); }, []);
  if (!s) return null;
  const rule = (g) => s.defaults[g] || {};
  const setRule = (g, r) => setS({ ...s, defaults: { ...s.defaults, [g]: r } });
  const order = s.orderText.split(',').map((x) => x.trim()).filter(Boolean);
  const save = () => run(() => call('training.saveSettings', {
    leaderboard: s.leaderboard, callOutPhone: s.callOutPhone, categoryOrder: order, defaults: s.defaults,
    categoryEs: Object.fromEntries(Object.entries(s.categoryEs || {}).filter(([k, v]) => order.includes(k) && v)),
  }), t.saved).then((r) => r && setS({ ...r, orderText: r.categoryOrder.join(', ') }));
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t.trainingSettings}</h2>
      <Field label={t.leaderboard}>
        <div className="seg tr-seg-wrap">
          <button type="button" className={s.leaderboard === 'all' ? 'on' : ''} onClick={() => setS({ ...s, leaderboard: 'all' })}>{t.boardAll}</button>
          <button type="button" className={s.leaderboard === 'managers' ? 'on' : ''} onClick={() => setS({ ...s, leaderboard: 'managers' })}>{t.boardManagers}</button>
        </div>
      </Field>
      <Field label={t.callOutLine} help={t.callOutLineHelp}>
        <input className="input" type="tel" inputMode="tel" value={s.callOutPhone} onChange={(e) => setS({ ...s, callOutPhone: e.target.value })} placeholder="(555) 010-0100" style={{ maxWidth: 260 }} />
      </Field>
      {FIELD_GROUPS.filter((g) => g !== 'selling').map((g) => (
        <Field key={g} label={t.whoSeesDefault(t.groupName[g])} help={t.managersSeeAll}>
          <div className="seg tr-seg-wrap" style={{ marginBottom: 6 }}>
            <button type="button" className={rule(g).all ? 'on' : ''} onClick={() => setRule(g, { all: true })}>{t.everyone}</button>
            <button type="button" className={!rule(g).all ? 'on' : ''} onClick={() => setRule(g, { departments: rule(g).departments || [], jobCodeIds: rule(g).jobCodeIds || [] })}>{t.onlySome}</button>
          </div>
          {!rule(g).all && <Chips options={s.departments} value={rule(g).departments || []} onChange={(v) => setRule(g, { ...rule(g), departments: v })} />}
        </Field>
      ))}
      <Field label={t.menuSections} help={t.menuSectionsHelp}><input className="input" value={s.orderText} onChange={(e) => setS({ ...s, orderText: e.target.value })} /></Field>
      <Field label={t.sectionNamesEs}>
        <div className="tr-es-grid">
          {order.map((c) => (
            <label key={c} className="row"><span className="small" style={{ flex: '0 0 40%', minWidth: 0, overflowWrap: 'anywhere' }}>{c}</span>
              <input className="input sm" value={s.categoryEs?.[c] || ''} placeholder={categoryLabel(c, 'es') !== c ? categoryLabel(c, 'es') : ''} onChange={(e) => setS({ ...s, categoryEs: { ...s.categoryEs, [c]: e.target.value } })} /></label>
          ))}
        </div>
      </Field>
      <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy} onClick={save}><Icon name="check" />{t.saveTraining}</button></div>
    </div>
  );
}
