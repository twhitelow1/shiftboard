// Answering reviews (the plan's `reviews` feature), for managers:
//   ReviewsTab         Positive impact → Reviews: every review (OpenTable, Google, Yelp…) with a source filter,
//                      stars, "Needs a reply", the names in it, and a reply panel; Yelp's API excerpts (kept 24
//                      hours, Yelp's terms) above them
//   ReplyPanel         Draft with AI → edit → Post to Google (edit or delete it there too), or Copy for Yelp,
//                      OpenTable and the rest, where there's no API to reply → marked replied
//   AddReviewDialog    paste one review by hand (Yelp's full review from Yelp for Business, TripAdvisor…)
//   ReplySettingsCard  Settings → Positive impact: which reviews alert the managers, the reply's tone, sign-off and
//                      the contact for unhappy guests
// The demo never calls Google, Yelp or the AI: its drafts come from a template (web/src/reviews-api.js).
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty, useAction } from '../ui.jsx';
import { useT, prettyDate } from '../i18n/index.js';
import { IS_DEMO } from '../api.js';
import { Stars, SourceBadge, Highlighted } from './ImpactShared.jsx';
import { aiStatus, draftReply, postGoogleReply, deleteGoogleReply, googleStatus } from '../reviews-api.js';
import '../impact.css';
import '../reviews.css';

const SOURCES = ['opentable', 'google', 'yelp', 'tripadvisor', 'facebook', 'manual', 'other'];
const PASTE_SOURCES = ['yelp', 'google', 'tripadvisor', 'facebook', 'other'];
// Where a manager answers a review by hand.
const SITE = { yelp: 'https://biz.yelp.com/', google: 'https://business.google.com/reviews', opentable: 'https://guestcenter.opentable.com/', tripadvisor: 'https://www.tripadvisor.com/Owners', facebook: 'https://www.facebook.com/' };
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const copyText = (s) => navigator.clipboard?.writeText(s).then(() => true, () => false) ?? Promise.resolve(false);

export function ReviewsTab({ args }) {
  const t = useT();
  const { call, version } = useApp();
  const [filter, setFilter] = useState({ source: '', stars: '', needsReply: false });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(null);
  const [ai, setAi] = useState(null);
  const [google, setGoogle] = useState(null);
  useEffect(() => {
    call('reviews.list', { ...args, source: filter.source || undefined, stars: filter.stars === '' ? undefined : Number(filter.stars), needsReply: filter.needsReply || undefined })
      .then((r) => { setData(r); setError(''); }).catch((e) => setError(e.message));
  }, [version, tick, JSON.stringify(args), filter.source, filter.stars, filter.needsReply]);
  useEffect(() => { aiStatus().then(setAi).catch(() => setAi({ available: false, reason: 'error' })); googleStatus().then(setGoogle).catch(() => setGoogle(null)); }, []);
  const googleOk = !!(google?.connected && google?.location && !google.needsReconnect);
  const changed = () => setTick((n) => n + 1);

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap rv-filters" style={{ gap: 8 }}>
        <select className="input sm" aria-label={t('impact.source')} value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value })}>
          <option value="">{t('impact.allSources')}</option>
          {SOURCES.map((s) => <option key={s} value={s}>{t(`impact.source_${s}`)}</option>)}
        </select>
        <select className="input sm" aria-label={t('impact.stars')} value={filter.stars} onChange={(e) => setFilter({ ...filter, stars: e.target.value })}>
          <option value="">{t('impact.allStars')}</option>
          {[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>{'★'.repeat(s)}</option>)}
        </select>
        <button className={`chip${filter.needsReply ? ' on' : ''}`} aria-pressed={filter.needsReply} onClick={() => setFilter({ ...filter, needsReply: !filter.needsReply })}>
          {filter.needsReply && <Icon name="check" size={12} />}{t('reviews.needsReplyFilter')}{data ? ` · ${data.needsReply}` : ''}
        </button>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAdding({ source: 'yelp' })}><Icon name="plus" />{t('reviews.addReview')}</button>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {data && <span className="small muted">{t('impact.reviewsCount', { count: data.total })}</span>}
      {ai && !ai.available && <div className="help">{t('reviews.aiNotSetUpHelp')}</div>}

      {data?.yelp?.length > 0 && (
        <div className="card card-pad col rv-yelp" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 8 }}><SourceBadge source="yelp" /><b>{t('reviews.yelpExcerpts')}</b></div>
          <div className="help">{t('reviews.yelpExcerptsHelp')}</div>
          {data.yelp.map((x) => <YelpExcerpt key={x.ref} x={x} onChanged={changed} onPaste={() => setAdding({ source: 'yelp', rating: x.rating, date: x.date, reviewer: x.reviewer, url: x.url })} />)}
        </div>
      )}

      {data && !data.items.length && !data.yelp?.length && <Empty icon="star" title={filter.needsReply ? t('reviews.allAnswered') : t('impact.noReviews')} />}
      {data?.items.map((r) => (
        <div key={r.id} className="card card-pad imp-item">
          <div className="imp-item-head"><SourceBadge source={r.source} /><Stars n={r.rating} small />
            <ReplyBadge r={r} />
            <span className="spacer" /><span className="tiny faint">{prettyDate(r.diningDate || r.date)}</span></div>
          <div className="imp-quote"><Highlighted text={r.text} spans={r.spans} /></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {r.reviewer && <span className="tiny faint">{r.reviewer}</span>}
            {r.people.map((p) => <span key={p.id} className={`badge ${p.status === 'confirmed' ? 'brand' : 'warn'}`}>{p.name}</span>)}
            <span className="spacer" />
            <button className={`btn sm${open === r.id ? '' : ' ghost'}`} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <Icon name={r.replied ? 'edit' : 'send'} />{r.replied ? t('reviews.seeReply') : t('reviews.reply')}
            </button>
          </div>
          {open === r.id && <ReplyPanel review={r} ai={ai} googleOk={googleOk} onDone={() => { changed(); }} />}
        </div>
      ))}
      {adding && <AddReviewDialog initial={adding} onClose={(saved) => { setAdding(null); if (saved) changed(); }} />}
    </div>
  );
}

function ReplyBadge({ r }) {
  const t = useT();
  if (!r.replied) return <span className={`badge ${r.rating <= 3 ? 'bad' : 'warn'}`}>{t('impact.needsReply')}</span>;
  const state = r.replySource === 'google' ? r.google?.replyState : null;
  if (state === 'REJECTED') return <span className="badge bad">{t('reviews.googleRejected')}</span>;
  if (state === 'PENDING') return <span className="badge warn">{t('reviews.googlePending')}</span>;
  return <span className="badge ok"><Icon name="check" size={12} />{r.replySource === 'google' ? t('reviews.onGoogle') : t('impact.replied')}</span>;
}

/** Draft with AI → edit → Post to Google, or Copy for the site → marked replied. */
export function ReplyPanel({ review: r, ai, googleOk, onDone }) {
  const t = useT();
  const { call, toast } = useApp();
  const [text, setText] = useState(r.reply || '');
  const [note, setNote] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [run, busy] = useAction();
  const canPost = r.source === 'google' && r.google?.canPost && (googleOk || IS_DEMO);
  const onGoogle = r.replied && r.replySource === 'google';
  const site = SITE[r.source];
  const n = words(text);

  const draft = async () => {
    setDrafting(true); setNote('');
    try {
      const d = await draftReply(r.id);
      if (!d.available) setNote(t('reviews.aiNotSetUp'));
      else { setText(d.text); if (d.sample) setNote(t('reviews.sampleDraft')); }
    } catch (e) { toast(e.message, 'bad'); } finally { setDrafting(false); }
  };
  const post = () => run(() => postGoogleReply(r.id, text), (x) => (x?.demo ? t('reviews.postedDemo') : onGoogle ? t('reviews.updatedOnGoogle') : t('reviews.postedToGoogle'))).then((x) => x && onDone());
  const remove = () => run(() => deleteGoogleReply(r.id), t('reviews.deletedFromGoogle')).then((x) => { setConfirmDelete(false); if (x) { setText(''); onDone(); } });
  const copy = async () => { toast((await copyText(text)) ? t('reviews.copied') : t('reviews.copyFailed'), 'ok'); };
  const mark = (replied) => run(() => call('reviews.markReplied', { id: r.id, reply: text, replied }), replied ? t('impact.markedReplied') : t('impact.markedNotReplied')).then((x) => x && onDone());

  return (
    <div className="rv-reply col" style={{ gap: 8 }}>
      {r.replied && r.reply && r.reply !== text && <div className="small"><b>{t('reviews.currentReply')}</b> <span className="muted">{r.reply}</span></div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn sm" disabled={drafting || busy || (ai && !ai.available)} onClick={draft} title={ai && !ai.available ? t('reviews.aiNotSetUp') : ''}>
          <Icon name="sparkle" />{drafting ? t('reviews.drafting') : t('reviews.draftWithAi')}
        </button>
        {ai && !ai.available && <span className="small muted">{t('reviews.aiNotSetUp')}</span>}
      </div>
      {note && <div className="help">{note}</div>}
      <label className="field"><span>{t('reviews.yourReply')}</span>
        <textarea className="input" rows={6} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder={t('reviews.replyPlaceholder')} />
      </label>
      <div className={`tiny ${n > 120 ? 'warn-text' : 'faint'}`}>{t('reviews.wordCount', { count: n })}{n > 120 ? ` · ${t('reviews.tooLong')}` : ''}</div>
      <div className="row wrap rv-actions" style={{ gap: 8 }}>
        {canPost ? (
          <>
            <button className="btn primary sm" disabled={busy || !text.trim()} onClick={post}><Icon name="send" />{onGoogle ? t('reviews.updateOnGoogle') : t('reviews.postToGoogle')}</button>
            {onGoogle && !confirmDelete && <button className="btn sm ghost" disabled={busy} onClick={() => setConfirmDelete(true)}><Icon name="trash" />{t('reviews.deleteFromGoogle')}</button>}
            {confirmDelete && <><span className="small">{t('reviews.deleteSure')}</span><button className="btn sm danger" disabled={busy} onClick={remove}>{t('common.delete')}</button><button className="btn sm ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button></>}
          </>
        ) : (
          <>
            <button className="btn primary sm" disabled={!text.trim()} onClick={copy}><Icon name="copy" />{t('reviews.copyReply')}</button>
            {(r.url || site) && <a className="btn sm" href={r.url || site} target="_blank" rel="noopener noreferrer"><Icon name="link" />{t('reviews.openSite', { site: t(`impact.source_${r.source}`) })}</a>}
            {!r.replied ? <button className="btn sm" disabled={busy} onClick={() => mark(true)}><Icon name="check" />{t('impact.markReplied')}</button>
              : <button className="btn sm ghost" disabled={busy} onClick={() => mark(false)}><Icon name="x" />{t('impact.markNotReplied')}</button>}
          </>
        )}
      </div>
      {!canPost && r.source === 'google' && !IS_DEMO && <div className="help">{t('reviews.googleNotSynced')}</div>}
      {!canPost && r.source !== 'google' && <div className="help">{t('reviews.noReplyApi', { site: t(`impact.source_${r.source}`) })}</div>}
    </div>
  );
}

/** One of Yelp's excerpts: no AI (Yelp's terms), copy and open Yelp, mark replied, or paste the full review. */
function YelpExcerpt({ x, onChanged, onPaste }) {
  const t = useT();
  const { call, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  const copyOpen = async () => {
    const ok = await copyText(text);
    toast(ok ? t('reviews.copied') : t('reviews.copyFailed'), 'ok');
    window.open(x.url || SITE.yelp, '_blank', 'noopener,noreferrer');
  };
  return (
    <div className="imp-item rv-excerpt">
      <div className="imp-item-head"><Stars n={x.rating} small />
        {x.replied ? <span className="badge ok"><Icon name="check" size={12} />{t('impact.replied')}</span> : <span className={`badge ${x.rating <= 3 ? 'bad' : 'warn'}`}>{t('impact.needsReply')}</span>}
        <span className="spacer" /><span className="tiny faint">{x.date ? prettyDate(x.date) : ''}</span></div>
      <div className="imp-quote"><Highlighted text={x.text} spans={x.spans} /></div>
      <div className="row wrap" style={{ gap: 6 }}>
        {x.reviewer && <span className="tiny faint">{x.reviewer}</span>}
        {x.people.map((p, i) => <span key={i} className={`badge ${p.status === 'confirmed' ? 'brand' : 'warn'}`}>{p.name}</span>)}
        <span className="spacer" />
        {x.url && <a className="btn sm ghost" href={x.url} target="_blank" rel="noopener noreferrer"><Icon name="link" />{t('reviews.readOnYelp')}</a>}
        <button className={`btn sm${open ? '' : ' ghost'}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="send" />{t('reviews.reply')}</button>
      </div>
      {open && (
        <div className="rv-reply col" style={{ gap: 8 }}>
          <div className="help">{t('reviews.yelpNoAi')}</div>
          <label className="field"><span>{t('reviews.yourReply')}</span>
            <textarea className="input" rows={5} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder={t('reviews.replyPlaceholder')} /></label>
          <div className="row wrap rv-actions" style={{ gap: 8 }}>
            <button className="btn primary sm" disabled={!text.trim()} onClick={copyOpen}><Icon name="copy" />{t('reviews.copyOpenYelp')}</button>
            <button className="btn sm" disabled={busy} onClick={() => run(() => call('reviews.markYelp', { ref: x.ref, replied: !x.replied }), x.replied ? t('impact.markedNotReplied') : t('impact.markedReplied')).then((r) => r && onChanged())}>
              <Icon name={x.replied ? 'x' : 'check'} />{x.replied ? t('impact.markNotReplied') : t('impact.markReplied')}</button>
            <button className="btn sm ghost" onClick={onPaste}><Icon name="plus" />{t('reviews.pasteFull')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Paste one review by hand: it's kept, its names count in Positive impact, and it can get an AI draft. */
export function AddReviewDialog({ initial = {}, onClose }) {
  const t = useT();
  const { call, today } = useApp();
  const [f, setF] = useState({ source: initial.source || 'yelp', rating: initial.rating ?? 5, date: initial.date || today, reviewer: initial.reviewer || '', text: '', url: initial.url || '' });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => { const r = await run(() => call('reviews.add', { ...f, rating: Number(f.rating) }), t('reviews.added')); if (r) onClose(true); };
  return (
    <Modal title={t('reviews.addReview')} sub={t('reviews.addReviewSub')} onClose={() => onClose(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !f.text.trim()} onClick={save}><Icon name="check" />{t('common.save')}</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="grid2">
          <Field label={t('impact.source')}><select className="input" value={f.source} onChange={set('source')}>{PASTE_SOURCES.map((s) => <option key={s} value={s}>{t(`impact.source_${s}`)}</option>)}</select></Field>
          <Field label={t('impact.stars')}><select className="input" value={f.rating} onChange={set('rating')}>{[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>{'★'.repeat(s)}</option>)}</select></Field>
        </div>
        <div className="grid2">
          <Field label={t('common.date')}><input className="input" type="date" max={today} value={f.date} onChange={set('date')} /></Field>
          <Field label={t('reviews.reviewer')} help={t('reviews.reviewerHelp')}><input className="input" value={f.reviewer} onChange={set('reviewer')} /></Field>
        </div>
        <Field label={t('reviews.reviewText')} help={f.source === 'yelp' ? t('reviews.pasteYelpHelp') : ''}><textarea className="input" rows={6} value={f.text} onChange={set('text')} /></Field>
        <Field label={t('reviews.reviewLink')}><input className="input" type="url" inputMode="url" placeholder="https://" value={f.url} onChange={set('url')} /></Field>
      </div>
    </Modal>
  );
}

/** Settings → Positive impact: review alerts and how AI drafts sound. Admins change it; managers see it. */
export function ReplySettingsCard() {
  const t = useT();
  const { call, has } = useApp();
  const [s, setS] = useState(null);
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (has('reviews') && has('impact')) call('reviews.settings').then((r) => { setS(r); setF(r); }).catch(() => {}); }, []);
  if (!s || !f) return null;
  const edit = s.canEdit;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const dirty = ['tone', 'signOff', 'contactEmail', 'contactPhone'].some((k) => f[k] !== s[k]);
  const save = (patch) => run(() => call('reviews.saveSettings', patch), t('impact.settingsSaved')).then((r) => { if (r) { setS(r); setF({ ...f, ...patch, ...r }); } });
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('reviews.settingsTitle')}</h2>
      <Field label={t('reviews.alerts')} help={t('reviews.alertsHelp')}>
        <select className="input" value={f.alerts} disabled={!edit || busy} onChange={(e) => save({ alerts: e.target.value })}>
          {['all', 'low', 'off'].map((a) => <option key={a} value={a}>{t(`reviews.alerts_${a}`)}</option>)}
        </select>
      </Field>
      <div className="grid2">
        <Field label={t('reviews.tone')}>
          <select className="input" value={f.tone} disabled={!edit} onChange={set('tone')}>{['warm', 'professional'].map((x) => <option key={x} value={x}>{t(`reviews.tone_${x}`)}</option>)}</select>
        </Field>
        <Field label={t('reviews.signOff')} help={t('reviews.signOffHelp')}><input className="input" value={f.signOff} disabled={!edit} placeholder={s.defaultSignOff} onChange={set('signOff')} /></Field>
      </div>
      <div className="grid2">
        <Field label={t('reviews.contactEmail')} help={t('reviews.contactHelp')}><input className="input" type="email" inputMode="email" value={f.contactEmail} disabled={!edit} onChange={set('contactEmail')} /></Field>
        <Field label={t('reviews.contactPhone')}><input className="input" type="tel" inputMode="tel" value={f.contactPhone} disabled={!edit} onChange={set('contactPhone')} /></Field>
      </div>
      <div className="help">{t('reviews.rulesHelp')}</div>
      {edit && <div><button className="btn primary sm" disabled={busy || !dirty} onClick={() => save({ tone: f.tone, signOff: f.signOff, contactEmail: f.contactEmail, contactPhone: f.contactPhone })}><Icon name="check" />{t('common.save')}</button></div>}
    </div>
  );
}


