// Employee manual: sections and pages with simple formatting, "I've read this", and (managers) editing,
// ordering, who has and hasn't read each page, and asking everyone to read it again. Words: training-strings.js.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty, useAction } from '../ui.jsx';
import { localize } from '../../../core/training.js';
import { Markdown, ModCard, LangTabs, TIcon, useT, useLang, fmtDay } from './TrainingShared.jsx';
import { plainText } from '../minimark.js';

export function Manual() {
  const { call, version, isMgr } = useApp();
  const t = useT();
  const lang = useLang();
  const [data, setData] = useState(null);
  const [editPage, setEditPage] = useState(null);
  const [editSection, setEditSection] = useState(null);
  const [run, busy] = useAction();
  const load = () => call('manual.list').then(setData);
  useEffect(() => { load(); }, [version]);
  if (!data) return <div className="empty">{t.loading}</div>;
  const sections = data.sections;
  const moveSection = (i, d) => {
    const ids = sections.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    run(() => call('manual.reorder', { sectionIds: ids }));
  };
  const movePage = (s, i, d) => {
    const ids = s.pages.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    run(() => call('manual.reorder', { pageIds: ids }));
  };
  return (
    <div>
      {isMgr && (
        <div className="tr-toolbar">
          <span className="spacer" />
          <button className="btn" onClick={() => setEditSection({})}><Icon name="plus" />{t.newSection}</button>
          <button className="btn primary" disabled={!sections.length} onClick={() => setEditPage({ sectionId: sections[0]?.id })}><Icon name="plus" />{t.newPage}</button>
        </div>
      )}
      {!sections.length && <div className="card"><Empty icon="star" title={t.noManual}>{isMgr ? t.noManualMgr : ''}</Empty></div>}
      {sections.map((s, si) => (
        <div key={s.id} className="section">
          <div className="tr-cat-title row">
            <span style={{ flex: 1, minWidth: 0 }}>{localize(s, lang).title}</span>
            {isMgr && <>
              <button className="btn sm icon ghost" disabled={busy || si === 0} onClick={() => moveSection(si, -1)} aria-label={t.moveUp}><Icon name="up" /></button>
              <button className="btn sm icon ghost" disabled={busy || si === sections.length - 1} onClick={() => moveSection(si, 1)} aria-label={t.moveDown}><Icon name="down" /></button>
              <button className="btn sm icon ghost" onClick={() => setEditSection(s)} aria-label={t.edit}><Icon name="edit" /></button>
            </>}
          </div>
          <div className="card list">
            {!s.pages.length && <div className="list-item small muted">{t.noPagesYet}</div>}
            {s.pages.map((p, pi) => {
              const v = localize(p, lang);
              return (
                <div key={p.id} className="list-item tr-page-row">
                  <a className="tr-plainlink tr-page-link" href={`#/training/manual/${p.id}`}>
                    {p.isCallOut ? <TIcon name="phone" size={18} /> : <TIcon name="cards" size={18} />}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="tr-page-title">{v.title}</span>
                      {isMgr && <span className="tiny muted">{t.readBy(p.ackCount, p.readerCount)}</span>}
                    </span>
                    {p.my.current ? <span className="badge ok"><Icon name="check" size={12} />{t.read}</span> : <span className="badge warn">{p.my.ackedAt ? t.readAgain : t.pleaseRead}</span>}
                  </a>
                  {isMgr && <span className="tr-page-move">
                    <button className="btn sm icon ghost" disabled={busy || pi === 0} onClick={() => movePage(s, pi, -1)} aria-label={t.moveUp}><Icon name="up" /></button>
                    <button className="btn sm icon ghost" disabled={busy || pi === s.pages.length - 1} onClick={() => movePage(s, pi, 1)} aria-label={t.moveDown}><Icon name="down" /></button>
                  </span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {editPage && <PageEditor page={editPage} sections={sections} onClose={(c) => { setEditPage(null); if (c) load(); }} />}
      {editSection && <SectionEditor section={editSection} onClose={(c) => { setEditSection(null); if (c) load(); }} />}
    </div>
  );
}

export function ManualPage({ id }) {
  const { call, version, isMgr } = useApp();
  const t = useT();
  const lang = useLang();
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [run, busy] = useAction();
  const load = () => call('manual.get', { id }).then(setP).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id, version]);
  if (err) return <div className="card"><Empty icon="alert" title={err}><a href="#/training/manual">{t.backToManual}</a></Empty></div>;
  if (!p) return <div className="empty">{t.loading}</div>;
  const v = localize(p, lang);
  const ack = async () => { const r = await run(() => call('manual.ack', { id }), t.thanksRead); if (r) setP({ ...p, ...r }); };
  const reread = async () => { const r = await run(() => call('manual.requireReack', { id }), t.askedToReread); if (r) setP({ ...p, ...r }); };
  return (
    <div className="tr-page">
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <a className="btn sm ghost" href="#/training/manual"><Icon name="left" />{t.backToManual}</a>
        <span className="spacer" />
        {isMgr && <button className="btn sm" onClick={() => setEditing(true)}><Icon name="edit" />{t.edit}</button>}
      </div>
      <article className="card card-pad">
        <div className="tr-kicker">{localize({ title: p.sectionTitle, es: { title: p.sectionEs } }, lang).title}</div>
        <h2 className="tr-page-h">{v.title}</h2>
        {lang === 'es' && !p.es?.body && p.body && <div className="help">{t.onlyInEnglish}</div>}
        <Markdown text={v.body} />
        <div className="tiny faint" style={{ marginTop: 12 }}>{t.updated(fmtDay(p.updatedAt, lang), p.updatedBy)}</div>
      </article>
      {p.isCallOut && <div style={{ marginTop: 12 }}><ModCard compact /></div>}
      <div className="card card-pad tr-ack">
        {p.my.current
          ? <div className="row"><Icon name="check" size={18} style={{ color: 'var(--ok)' }} /><span>{t.youReadOn(fmtDay(p.my.ackedAt, lang))}</span></div>
          : <>
            {p.my.ackedAt && <div className="small muted">{t.changedSince(fmtDay(p.my.ackedAt, lang))}</div>}
            <button className="btn primary block" disabled={busy} onClick={ack}><Icon name="check" />{t.iveRead}</button>
          </>}
      </div>
      {isMgr && (
        <div className="card card-pad tr-ackreport">
          <div className="row wrap">
            <b style={{ flex: 1 }}>{t.readBy(p.ackCount, p.readerCount)}</b>
            <button className="btn sm" disabled={busy || !p.ackCount} onClick={reread}>{t.askEveryoneAgain}</button>
          </div>
          <details>
            <summary className="small">{t.notReadYet(p.missing.length)}</summary>
            <div className="small muted tr-names">{p.missing.map((m) => m.name + (m.oldAt ? ` (${t.oldVersion})` : '')).join(', ') || '—'}</div>
          </details>
          <details>
            <summary className="small">{t.haveRead(p.acks.length)}</summary>
            <ul className="tr-plain small">{p.acks.map((a) => <li key={a.userId}>{a.name} · {fmtDay(a.at, lang)}</li>)}</ul>
          </details>
        </div>
      )}
      {editing && <PageEditorLoader id={id} onClose={(c, gone) => { setEditing(false); if (gone) location.hash = '#/training/manual'; else if (c) load(); }} />}
    </div>
  );
}

function PageEditorLoader({ id, onClose }) {
  const { call } = useApp();
  const [data, setData] = useState(null);
  useEffect(() => { Promise.all([call('manual.get', { id }), call('manual.list')]).then(([page, list]) => setData({ page, sections: list.sections })); }, [id]);
  return data ? <PageEditor page={data.page} sections={data.sections} onClose={onClose} /> : null;
}

function PageEditor({ page, sections, onClose }) {
  const { call } = useApp();
  const t = useT();
  const lang = useLang();
  const [edLang, setEdLang] = useState('en');
  const [f, setF] = useState(() => ({ id: page.id, sectionId: page.sectionId || sections[0]?.id, title: page.title || '', body: page.body || '', isCallOut: !!page.isCallOut,
    es: { title: page.es?.title || '', body: page.es?.body || '' }, reack: false }));
  const [preview, setPreview] = useState(false);
  const [run, busy] = useAction();
  const [sure, setSure] = useState(false);
  const side = edLang === 'es' ? f.es : f;
  const setSide = (patch) => setF((x) => (edLang === 'es' ? { ...x, es: { ...x.es, ...patch } } : { ...x, ...patch }));
  const save = async () => { if (await run(() => call('manual.savePage', f), t.saved)) onClose(true); };
  const del = async () => {
    if (!sure) return setSure(true);
    if (await run(() => call('manual.deletePage', { id: f.id }), t.deleted)) onClose(true, true);
  };
  return (
    <Modal wide title={f.id ? t.editPage : t.newPage} onClose={() => onClose(false)}
      footer={<>
        {f.id && <button className={`btn danger ${sure ? 'solid' : ''}`} onClick={del} disabled={busy}><Icon name="trash" />{sure ? t.tapAgainToDelete : t.delete}</button>}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t.cancel}</button>
        <button className="btn primary" onClick={save} disabled={busy}>{t.save}</button>
      </>}>
      <div className="grid2">
        <Field label={t.section}>
          <select className="input" value={f.sectionId} onChange={(e) => setF({ ...f, sectionId: e.target.value })}>
            {sections.map((s) => <option key={s.id} value={s.id}>{localize(s, lang).title}</option>)}
          </select>
        </Field>
        <div className="row tr-ed-lang" style={{ alignSelf: 'end' }}><LangTabs value={edLang} onChange={setEdLang} /></div>
      </div>
      <Field label={t.title}><input className="input" value={side.title} placeholder={edLang === 'es' ? f.title : ''} onChange={(e) => setSide({ title: e.target.value })} /></Field>
      <div className="row"><span className="field-label small" style={{ fontWeight: 600, color: 'var(--text-2)', flex: 1 }}>{t.pageText}</span>
        <div className="seg"><button type="button" className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>{t.write}</button><button type="button" className={preview ? 'on' : ''} onClick={() => setPreview(true)}>{t.preview}</button></div>
      </div>
      {preview ? <div className="card card-pad tr-preview"><Markdown text={side.body || (edLang === 'es' ? f.body : '')} /></div>
        : <textarea className="input tr-body-input" rows="12" value={side.body} placeholder={edLang === 'es' ? plainText(f.body, 200) : ''} onChange={(e) => setSide({ body: e.target.value })} />}
      <div className="help tr-format-help">{t.formatHelp}</div>
      <label className="check"><input type="checkbox" checked={f.isCallOut} onChange={(e) => setF({ ...f, isCallOut: e.target.checked })} />{t.isCallOutPage}</label>
      {f.id && <label className="check"><input type="checkbox" checked={f.reack} onChange={(e) => setF({ ...f, reack: e.target.checked })} />{t.reackOnSave}</label>}
    </Modal>
  );
}

function SectionEditor({ section, onClose }) {
  const { call } = useApp();
  const t = useT();
  const [f, setF] = useState({ id: section.id, title: section.title || '', es: { title: section.es?.title || '' } });
  const [run, busy] = useAction();
  const save = async () => { if (await run(() => call('manual.saveSection', f), t.saved)) onClose(true); };
  const del = async () => { if (await run(() => call('manual.deleteSection', { id: f.id }), t.deleted)) onClose(true); };
  return (
    <Modal title={f.id ? t.editSection : t.newSection} onClose={() => onClose(false)}
      footer={<>
        {f.id && <button className="btn danger" onClick={del} disabled={busy}><Icon name="trash" />{t.delete}</button>}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t.cancel}</button>
        <button className="btn primary" onClick={save} disabled={busy}>{t.save}</button>
      </>}>
      <Field label={t.sectionName}><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
      <Field label={t.sectionNameEs}><input className="input" value={f.es.title} placeholder={f.title} onChange={(e) => setF({ ...f, es: { title: e.target.value } })} /></Field>
    </Modal>
  );
}
