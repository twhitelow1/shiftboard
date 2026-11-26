// OpenTable in the web app.
//   OpenTablePanel     Settings → Integrations → OpenTable: import OpenTable's exports (works today, no API
//                      access needed), what's in, the next two weeks' bookings, and the API sync once
//                      OpenTable grants access (Sync now, last sync).
//   GuestImportDialog  a reservations or reviews export → columns → preview → save. Also takes review exports
//                      from Google, Yelp or TripAdvisor (Positive impact → Kudos). Read here, in the browser
//                      (core/guest-csv.js): phone and email columns never leave this page, names are cut to
//                      "Dana K.", and the file goes up in parts. Re-importing never counts twice.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal, useAction } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { opentableStatus, opentableSyncAll } from '../opentable-api.js';
import { readFile, readReservations, readReviews, mappingProblems, mappingToNames, detectColumns, FIELDS, chunkItems } from '../../../core/guest-csv.js';
import { useT, prettyDate, fmtTime, stamp, translateError } from '../i18n/index.js';
import '../labor.css';
import '../impact.css';

const MAX_SHOWN = 120;
const n = (c, k) => c?.[k] || 0;

/** embedded: inside Settings → Integrations. connect: the API credentials are pasted above. */
export function OpenTablePanel({ connect }) {
  const t = useT();
  const { call, version, managed, toast, refresh } = useApp();
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(null);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    opentableStatus().then(setStatus).catch((e) => setError(e.message));
    call('opentable.get').then(setInfo).catch((e) => setError(e.message));
  }, [version]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await opentableSyncAll();
      toast(t('opentable.syncedToast', { reservations: n(r.counts, 'reservationsNew') + n(r.counts, 'reservationsUpdated'), reviews: n(r.counts, 'reviewsNew') + n(r.counts, 'reviewsUpdated') }));
    } catch (e) { toast(translateError(e.message), 'bad'); } finally { setSyncing(false); refresh(); }
  };
  const last = info?.lastSync;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small muted">{t('opentable.intro')}</div>
      {error && !info && <div className="alert bad">{translateError(error)}</div>}

      <div className="adp-block">
        <b>{t('opentable.importTitle')}</b>
        <div className="small muted">{t('opentable.importHelp')}</div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary sm" onClick={() => setImporting('reservations')}><Icon name="upload" />{t('opentable.importReservations')}</button>
          <button className="btn sm" onClick={() => setImporting('reviews')}><Icon name="upload" />{t('opentable.importReviews')}</button>
        </div>
        <ExportHelp />
      </div>

      {info && (
        <div className="tp-facts">
          <div><span>{t('opentable.reservations')}</span><b>{info.totals.reservations}</b></div>
          <div><span>{t('opentable.reviews')}</span><b>{t('opentable.reviewsLine', { count: info.totals.reviews, five: info.totals.fiveStar })}</b></div>
          <div><span>{t('opentable.requests')}</span><b>{info.totals.requests}</b></div>
          <div><span>{t('opentable.lastImport')}</span><b>{info.imports[0] ? stamp(info.imports[0].at) : t('opentable.never')}</b></div>
        </div>
      )}
      {info?.upcoming?.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <b className="small">{t('opentable.upcoming')}</b>
          <div className="ot-upcoming">
            {info.upcoming.map((d) => <div key={d.date}><span className="tiny faint">{prettyDate(d.date)}</span><b>{d.covers}</b><span className="tiny faint">{t('opentable.parties', { count: d.parties })}</span></div>)}
          </div>
          <div className="help">{t('opentable.forecastHelp')}</div>
        </div>
      )}
      {info?.imports?.length > 0 && (
        <details className="tp-help">
          <summary>{t('opentable.history', { count: info.imports.length })}</summary>
          <ul className="adp-skipped">
            {info.imports.slice(0, 8).map((i) => <li key={i.id}><b>{t(`opentable.kind_${i.kind}`)}</b> {i.fileName || ''} · {stamp(i.at)} · {t('opentable.importCounts', { added: n(i.counts, 'new'), updated: n(i.counts, 'updated'), same: n(i.counts, 'same') })}</li>)}
          </ul>
        </details>
      )}

      <div className="adp-block">
        <b>{t('opentable.apiTitle')}</b>
        {IS_DEMO || status?.demo ? <div className="help">{t('opentable.apiDemo')}</div>
          : !status ? <div className="small faint">{t('common.loading')}</div>
            : status.configured ? (
              <>
                <div className="small">{t('opentable.apiConnected', { rid: status.rid })}</div>
                {last && (last.ok ? <div className="alert ok"><Icon name="check" size={16} /><div>{t('opentable.lastSyncLine', { when: stamp(last.at), reservations: n(last.counts, 'reservationsNew') + n(last.counts, 'reservationsUpdated'), reviews: n(last.counts, 'reviewsNew') + n(last.counts, 'reviewsUpdated') })}</div></div>
                  : <div className="alert bad"><Icon name="alert" size={16} /><div>{t('opentable.lastSyncFailed', { error: translateError(last.error) })}</div></div>)}
                {(last?.warnings || []).map((w) => <div key={w.code} className="help">{t(`opentable.warn_${w.code}`)}</div>)}
                <div className="row wrap" style={{ gap: 8 }}>
                  <button className="btn sm" disabled={syncing} onClick={sync}><Icon name="download" />{t('opentable.syncNow')}</button>
                  {syncing && <span className="small muted">{t('opentable.syncing')}</span>}
                  <span className="help">{status.cron ? t('opentable.dailyOn') : t('opentable.dailyOff')}</span>
                </div>
              </>
            ) : <div className="help">{connect ? t('opentable.apiPaste') : managed ? t('opentable.apiAskDublow') : t('opentable.apiEnv', { names: status.missing.join(', ') })} {t('opentable.apiHowTo')}</div>}
      </div>
      {importing && <GuestImportDialog kind={importing} source="opentable" onClose={() => setImporting(null)} />}
    </div>
  );
}

function ExportHelp() {
  const t = useT();
  return (
    <details className="tp-help">
      <summary>{t('opentable.whereToExport')}</summary>
      <ul>
        <li>{t('opentable.exportReservations')}</li>
        <li>{t('opentable.exportReviews')}</li>
        <li>{t('opentable.exportPrivacy')}</li>
      </ul>
    </details>
  );
}

const SOURCES = ['google', 'yelp', 'tripadvisor', 'facebook', 'other'];

/**
 * kind: 'reservations' | 'reviews'. source: 'opentable' (then it's OpenTable's import, opentable.*) or a review
 * site (impact.*: reviews only). pickSource: let the manager choose the review site.
 */
export function GuestImportDialog({ kind, source: initialSource = 'opentable', pickSource = false, onClose }) {
  const t = useT();
  const { call, toast, refresh } = useApp();
  const [source, setSource] = useState(initialSource);
  const [file, setFile] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [step, setStep] = useState('file');
  const [readError, setReadError] = useState('');
  const [preview, setPreview] = useState(null);
  const [remembered, setRemembered] = useState(null);
  const [paste, setPaste] = useState('');
  const [run, busy] = useAction();
  const inputRef = useRef(null);
  const isOt = source === 'opentable';

  useEffect(() => {
    if (isOt) call('opentable.get').then((i) => setRemembered(i.columns?.[kind] || null)).catch(() => {});
  }, [source]);

  const load = (name, text) => {
    setReadError('');
    try {
      const r = readFile(text, kind, { remembered });
      if (!r.header.length || r.rows.length < 2) { setReadError(t('opentable.fileEmpty')); return; }
      setFile({ name, rows: r.rows, header: r.header, headerRow: r.headerRow, remembered: r.remembered });
      setMapping(r.mapping);
      setPreview(null);
      setStep('columns');
    } catch (e) { setReadError(t('opentable.couldntRead', { error: e.message })); }
  };
  const pick = async (f) => {
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { setReadError(t('opentable.fileTooBig')); return; }
    load(f.name, await f.text());
  };

  const parsed = useMemo(() => (file && mapping ? (kind === 'reviews' ? readReviews(file.rows, mapping, file.headerRow, { source }) : readReservations(file.rows, mapping, file.headerRow)) : null), [file, mapping, kind, source]);
  const problems = mapping ? mappingProblems(mapping, kind) : [];
  const strip = (items) => items.map(({ row, ...x }) => x);

  // A big file goes in parts; the preview adds the parts up.
  const runPreview = async () => {
    const r = await run(async () => {
      const total = { counts: {}, dates: [], rows: [], people: new Map(), needsReview: 0 };
      for (const part of chunkItems(strip(parsed.items))) {
        const p = isOt ? await call('opentable.previewImport', { kind, items: part }) : await call('impact.previewReviews', { source, items: part });
        for (const [k, v] of Object.entries(p.counts || {})) total.counts[k] = (total.counts[k] || 0) + v;
        total.dates.push(...(p.dates || []));
        if (total.rows.length < MAX_SHOWN) total.rows.push(...(p.rows || []));
        for (const x of p.people || []) { const e = total.people.get(x.userId) || { ...x, mentions: 0, fiveStar: 0 }; e.mentions += x.mentions; e.fiveStar += x.fiveStar; total.people.set(x.userId, e); }
        total.needsReview += p.needsReview || 0;
      }
      total.dates.sort();
      return { ...total, people: [...total.people.values()].sort((a, b) => b.mentions - a.mentions) };
    });
    if (r) { setPreview(r); setStep('preview'); }
  };
  const save = async () => {
    const columns = mappingToNames(mapping, file.header);
    const r = await run(async () => {
      const counts = {};
      let importId = null;
      const parts = chunkItems(strip(parsed.items));
      for (const [i, part] of parts.entries()) {
        const x = isOt ? await call('opentable.import', { kind, items: part, fileName: file.name, columns, importId })
          : await call('impact.importReviews', { source, items: part, fileName: file.name, columns, final: i === parts.length - 1 });
        importId = x.importId || importId;
        for (const [k, v] of Object.entries(x.counts || {})) counts[k] = (counts[k] || 0) + v;
      }
      return counts;
    });
    if (!r) return;
    toast(t('opentable.importedToast', { added: n(r, 'new'), updated: n(r, 'updated'), same: n(r, 'same') }));
    refresh();
    onClose();
  };

  const footer = (
    <>
      {step !== 'file' && <button className="btn" disabled={busy} onClick={() => setStep(step === 'preview' ? 'columns' : 'file')}><Icon name="left" />{t('adp.back')}</button>}
      <span className="spacer" />
      {step === 'file' && <button className="btn" onClick={onClose}>{t('common.cancel')}</button>}
      {step === 'columns' && <button className="btn primary" disabled={busy || problems.length > 0 || !parsed?.items.length} onClick={runPreview}>{t('opentable.preview')}<Icon name="right" /></button>}
      {step === 'preview' && <button className="btn primary" disabled={busy || !(n(preview.counts, 'new') + n(preview.counts, 'updated'))} onClick={save}><Icon name="check" />{t('opentable.saveCount', { count: n(preview.counts, 'new') + n(preview.counts, 'updated') })}</button>}
    </>
  );
  const title = isOt ? t(`opentable.importTitle_${kind}`) : t('opentable.importTitle_siteReviews');

  return (
    <Modal wide title={title} sub={file ? file.name : t(`opentable.importSub_${kind}`)} onClose={onClose} footer={footer}>
      {step === 'file' && (
        <div className="col" style={{ gap: 12 }}>
          {pickSource && (
            <label className="field"><span>{t('opentable.reviewsFrom')}</span>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{t(`impact.source_${s}`)}</option>)}</select>
            </label>
          )}
          <div className="adp-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}>
            <Icon name="upload" size={22} />
            <div style={{ fontWeight: 700 }}>{t('opentable.chooseFile')}</div>
            <div className="small muted">{t(`opentable.chooseFileHelp_${kind}`)}</div>
            <button className="btn primary sm" onClick={() => inputRef.current?.click()}>{t('adp.pickFile')}</button>
            <input ref={inputRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => pick(e.target.files?.[0])} />
          </div>
          {readError && <div className="alert bad"><Icon name="alert" size={16} />{readError}</div>}
          {isOt ? <ExportHelp /> : <div className="help">{t('opentable.siteExportHelp')}</div>}
          <details className="tp-help">
            <summary>{t('adp.orPaste')}</summary>
            <textarea className="input adp-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t('opentable.pastePlaceholder')} />
            <button className="btn sm" style={{ marginTop: 6 }} disabled={!paste.trim()} onClick={() => load(t('adp.pastedRows'), paste)}>{t('adp.readPasted')}</button>
          </details>
        </div>
      )}
      {step === 'columns' && file && mapping && <ColumnStep kind={kind} file={file} mapping={mapping} setMapping={setMapping} parsed={parsed} problems={problems} onGuess={() => setMapping(detectColumns(file.header, kind))} />}
      {step === 'preview' && preview && <PreviewStep kind={kind} preview={preview} parsed={parsed} />}
    </Modal>
  );
}

function ColumnStep({ kind, file, mapping, setMapping, parsed, problems, onGuess }) {
  const t = useT();
  const sample = file.rows.slice(file.headerRow + 1).filter((r) => r.some(Boolean)).slice(0, 3);
  const shown = FIELDS[kind].filter((f) => f !== 'phone' && f !== 'email');
  const left = ['phone', 'email'].filter((f) => mapping[f] != null);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small muted">{file.remembered ? t('adp.columnsRemembered') : t('adp.columnsGuessed')} <button className="btn ghost sm" onClick={onGuess}>{t('adp.guessAgain')}</button></div>
      {left.length > 0 && <div className="alert ok"><Icon name="lock" size={16} /><div>{t('opentable.leftOut', { columns: left.map((f) => file.header[mapping[f]]).join(', ') })}</div></div>}
      <div className="adp-map">
        {shown.map((f) => (
          <label key={f} className="adp-map-row">
            <span>{t(`opentable.field_${f}`)}</span>
            <select className="input sm" value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">{t('adp.noColumn')}</option>
              {file.header.map((h, i) => <option key={i} value={i}>{h || t('adp.columnN', { n: i + 1 })}</option>)}
            </select>
            <span className="tiny faint adp-map-sample">{['guest', 'firstName', 'lastName', 'reviewer'].includes(f) ? t('opentable.nameShortened') : sample.map((r) => (mapping[f] == null ? '' : r[mapping[f]])).filter(Boolean).slice(0, 2).join(' · ').slice(0, 80)}</span>
          </label>
        ))}
      </div>
      {problems.length > 0 && <div className="alert warn"><Icon name="alert" size={16} />{problems.map((p) => t(`opentable.need_${p}`)).join(' ')}</div>}
      {parsed && !problems.length && (
        <div className={`alert ${parsed.items.length ? 'info' : 'warn'}`}><Icon name={parsed.items.length ? 'check' : 'alert'} size={16} />
          <div>{t(`opentable.found_${kind}`, { count: parsed.items.length })}{parsed.skipped.length ? ` ${t('adp.skippedRows', { count: parsed.skipped.length })}` : ''}</div></div>
      )}
      {parsed?.skipped.length > 0 && (
        <details className="tp-help">
          <summary>{t('adp.whySkipped', { count: parsed.skipped.length })}</summary>
          <ul className="adp-skipped">{parsed.skipped.slice(0, 40).map((s, i) => <li key={i}><b>{t('adp.rowN', { n: s.row })}</b> {t(`opentable.skip_${s.reason}`)} <span className="faint">{s.text}</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

function PreviewStep({ kind, preview }) {
  const t = useT();
  const c = preview.counts;
  const status = (s) => ({ new: ['ok', t('adp.statusNew')], updated: ['brand', t('adp.statusUpdated')], same: ['', t('adp.statusSame')], duplicate: ['warn', t('adp.statusDuplicate')] }[s] || ['', s]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="adp-chips">
        <span className="badge brand">{preview.dates.length ? `${prettyDate(preview.dates[0])} – ${prettyDate(preview.dates.at(-1))}` : '—'}</span>
        <span className="badge ok">{t('adp.chipNew', { count: n(c, 'new') })}</span>
        {n(c, 'updated') > 0 && <span className="badge brand">{t('adp.chipUpdated', { count: c.updated })}</span>}
        {n(c, 'same') > 0 && <span className="badge">{t('adp.chipSame', { count: c.same })}</span>}
        {n(c, 'duplicate') > 0 && <span className="badge warn">{t('adp.chipDuplicate', { count: c.duplicate })}</span>}
        {kind === 'reservations' && <span className="badge">{t('opentable.chipCovers', { count: n(c, 'covers') })}</span>}
        {kind === 'reservations' && <span className="badge brand">{t('opentable.chipRequests', { count: n(c, 'requests') })}</span>}
        {kind === 'reviews' && <span className="badge ok">{t('opentable.chipFiveStar', { count: n(c, 'fiveStar') })}</span>}
      </div>
      {n(c, 'new') + n(c, 'updated') === 0 && <div className="alert info"><Icon name="check" size={16} />{t('opentable.nothingNew')}</div>}
      {kind === 'reviews' && (preview.people.length > 0 || preview.needsReview > 0) && (
        <div className="col" style={{ gap: 6 }}>
          <h3>{t('opentable.namesFound')}</h3>
          <div className="row wrap" style={{ gap: 6 }}>{preview.people.map((p) => <span key={p.userId} className="badge brand">{p.name} · {p.mentions}{p.fiveStar ? ` · ${p.fiveStar}★` : ''}</span>)}</div>
          {preview.needsReview > 0 && <div className="help">{t('opentable.needsReviewAfter', { count: preview.needsReview })}</div>}
        </div>
      )}
      <div className="table-wrap">
        <table className="table lr-table adp-preview">
          <thead>{kind === 'reviews'
            ? <tr><th>{t('common.date')}</th><th>{t('opentable.field_rating')}</th><th>{t('opentable.field_text')}</th><th>{t('adp.status')}</th></tr>
            : <tr><th>{t('common.date')}</th><th>{t('opentable.field_partySize')}</th><th>{t('opentable.field_notes')}</th><th>{t('adp.status')}</th></tr>}</thead>
          <tbody>
            {preview.rows.slice(0, MAX_SHOWN).map((r, i) => {
              const [cls, label] = status(r.change || r.status);
              return kind === 'reviews'
                ? <tr key={i}><td className="lr-stick">{prettyDate(r.date)}</td><td>{'★'.repeat(Math.round(r.rating))}</td><td className="small">{r.text}</td><td><span className={`badge ${cls}`}>{label}</span></td></tr>
                : <tr key={i}><td className="lr-stick">{prettyDate(r.date)}{r.time ? ` ${fmtTime(r.time)}` : ''}</td><td className="num">{r.partySize}</td><td className="small">{[r.requestedServer, r.notes].filter(Boolean).join(' · ')}</td><td><span className={`badge ${cls}`}>{label}</span></td></tr>;
            })}
          </tbody>
        </table>
      </div>
      <div className="help">{t('opentable.reimportHelp')}</div>
    </div>
  );
}
