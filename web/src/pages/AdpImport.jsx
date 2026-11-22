// Labor review → Import ADP hours: a timecard export (CSV) from any ADP product. The file is read
// here (core/adp-csv.js), the columns confirmed (and remembered for next time), then the server, or
// the demo, previews the match against ShiftBoard's people and saves. Re-importing never doubles.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal, useAction } from '../ui.jsx';
import { readAdpCsv, readPunches, mappingProblems, mappingToNames, mappingFromNames, detectColumns } from '../../../core/adp-csv.js';
import { useT, prettyDate, fmtTime, num } from '../i18n/index.js';
import '../labor.css';

const MAX_SHOWN = 200;
// The columns a manager confirms, in order. in/out can be several columns (In, Out, In, Out): the first pair is shown.
const FIELDS = ['name', 'employeeId', 'date', 'in', 'out', 'hours', 'otHours', 'payCode', 'department'];
const hm = (stamp) => (stamp ? fmtTime(stamp.slice(11, 16)) : '');
const h1 = (n) => (n == null ? '—' : num(Math.round(n * 100) / 100, { maximumFractionDigits: 2 }));

/** The button on Labor review (and in Settings → Integrations → ADP). */
export function AdpImportButton({ className = 'btn sm', label }) {
  const t = useT();
  const { has } = useApp();
  const [open, setOpen] = useState(false);
  if (has && !has('adp')) return null; // not in this restaurant's plan
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}><Icon name="upload" />{label || t('adp.importHours')}</button>
      {open && <AdpImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function AdpImportDialog({ onClose }) {
  const t = useT();
  const { call, employees, jobs, toast, refresh } = useApp();
  const [file, setFile] = useState(null); // { name, rows, header, headerRow }
  const [mapping, setMapping] = useState(null);
  const [remembered, setRemembered] = useState(null); // the columns saved from the last import
  const [rememberedUsed, setRememberedUsed] = useState(false);
  const [step, setStep] = useState('file');
  const [readError, setReadError] = useState('');
  const [preview, setPreview] = useState(null);
  const [matches, setMatches] = useState({});
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [paste, setPaste] = useState('');
  const [run, busy] = useAction();
  const inputRef = useRef(null);
  const people = useMemo(() => [...employees].filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name)), [employees]);

  useEffect(() => { call('adp.get').then((i) => setRemembered(i.csvColumns || null)).catch(() => {}); }, []);

  const load = (name, text) => {
    setReadError('');
    try {
      const r = readAdpCsv(text, { remembered });
      if (!r.header.length || r.rows.length < 2) { setReadError(t('adp.fileLooksEmpty')); return; }
      setFile({ name, rows: r.rows, header: r.header, headerRow: r.headerRow });
      setMapping(r.mapping);
      setRememberedUsed(r.remembered);
      setPreview(null);
      setMatches({});
      setStep('columns');
    } catch (e) {
      setReadError(t('adp.couldntReadFile', { error: e.message }));
    }
  };
  const pick = async (f) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setReadError(t('adp.fileTooBig')); return; }
    load(f.name, await f.text());
  };

  const parsed = useMemo(() => (file && mapping ? readPunches(file.rows, mapping, file.headerRow) : null), [file, mapping]);
  const problems = mapping ? mappingProblems(mapping) : [];

  const runPreview = async (m = matches) => {
    const r = await run(() => call('adp.previewImport', { punches: parsed.punches, matches: m }));
    if (r) { setPreview(r); setStep('preview'); }
  };
  const save = async () => {
    const r = await run(() => call('adp.importCsv', { punches: parsed.punches, matches, fileName: file.name, columns: mappingToNames(mapping, file.header) }));
    if (!r) return;
    const c = r.counts;
    toast(t('adp.importedLine', { count: c.new + c.updated + c.same, added: c.new, updated: c.updated }));
    refresh();
    onClose();
  };

  const footer = (
    <>
      {step !== 'file' && <button className="btn" disabled={busy} onClick={() => setStep(step === 'preview' ? 'columns' : 'file')}><Icon name="left" />{t('adp.back')}</button>}
      <span className="spacer" />
      {step === 'file' && <button className="btn" onClick={onClose}>{t('common.cancel')}</button>}
      {step === 'columns' && <button className="btn primary" disabled={busy || problems.length > 0 || !parsed?.punches.length} onClick={() => runPreview()}>{t('adp.previewImport')}<Icon name="right" /></button>}
      {step === 'preview' && <button className="btn primary" disabled={busy || !preview || !(preview.counts.new + preview.counts.updated + preview.removals)} onClick={save}><Icon name="check" />{t('adp.saveCount', { count: preview?.counts.new + preview?.counts.updated || 0 })}</button>}
    </>
  );

  return (
    <Modal wide title={t('adp.importTitle')} sub={file ? file.name : t('adp.importSub')} onClose={onClose} footer={footer}>
      {step === 'file' && (
        <div className="col" style={{ gap: 12 }}>
          <div className="adp-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}>
            <Icon name="upload" size={22} />
            <div style={{ fontWeight: 700 }}>{t('adp.chooseFile')}</div>
            <div className="small muted">{t('adp.chooseFileHelp')}</div>
            <button className="btn primary sm" onClick={() => inputRef.current?.click()}>{t('adp.pickFile')}</button>
            <input ref={inputRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => pick(e.target.files?.[0])} />
          </div>
          {readError && <div className="alert bad"><Icon name="alert" size={16} />{readError}</div>}
          <details className="tp-help">
            <summary>{t('adp.whereToExport')}</summary>
            <ul>
              <li>{t('adp.exportRun')}</li>
              <li>{t('adp.exportWfn')}</li>
              <li>{t('adp.exportEzlm')}</li>
              <li>{t('adp.exportWfm')}</li>
            </ul>
            <div className="help" style={{ marginTop: 6 }}>{t('adp.exportColumnsHelp')}</div>
          </details>
          <details className="tp-help">
            <summary>{t('adp.orPaste')}</summary>
            <textarea className="input adp-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t('adp.pastePlaceholder')} />
            <button className="btn sm" style={{ marginTop: 6 }} disabled={!paste.trim()} onClick={() => load(t('adp.pastedRows'), paste)}>{t('adp.readPasted')}</button>
          </details>
        </div>
      )}

      {step === 'columns' && file && mapping && (
        <ColumnStep file={file} mapping={mapping} setMapping={setMapping} parsed={parsed} problems={problems}
          rememberedUsed={rememberedUsed} onGuess={() => { setMapping(detectColumns(file.header)); setRememberedUsed(false); }}
          onRemembered={remembered && mappingFromNames(remembered, file.header) ? () => { setMapping(mappingFromNames(remembered, file.header)); setRememberedUsed(true); } : null} />
      )}

      {step === 'preview' && preview && (
        <PreviewStep preview={preview} parsed={parsed} people={people} jobs={jobs} matches={matches} busy={busy}
          onlyProblems={onlyProblems} setOnlyProblems={setOnlyProblems}
          setMatch={(key, userId) => { const m = { ...matches, [key]: userId }; setMatches(m); runPreview(m); }} />
      )}
    </Modal>
  );
}

function ColumnStep({ file, mapping, setMapping, parsed, problems, rememberedUsed, onGuess, onRemembered }) {
  const t = useT();
  const sample = file.rows.slice(file.headerRow + 1).filter((r) => r.some(Boolean)).slice(0, 3);
  const set = (f, v) => {
    const i = v === '' ? null : Number(v);
    if (f === 'in' || f === 'out') {
      const rest = (mapping[f] || []).slice(1).filter((x) => x !== i);
      setMapping({ ...mapping, [f]: i == null ? rest : [i, ...rest] });
    } else setMapping({ ...mapping, [f]: i });
  };
  const valueOf = (f) => (f === 'in' || f === 'out' ? mapping[f]?.[0] ?? '' : mapping[f] ?? '');
  const shown = (f) => (f === 'in' || f === 'out' ? mapping[f] || [] : mapping[f] == null ? [] : [mapping[f]]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small muted">{rememberedUsed ? t('adp.columnsRemembered') : t('adp.columnsGuessed')}
        {' '}{rememberedUsed ? <button className="btn ghost sm" onClick={onGuess}>{t('adp.guessAgain')}</button> : onRemembered && <button className="btn ghost sm" onClick={onRemembered}>{t('adp.useLastColumns')}</button>}</div>
      <div className="adp-map">
        {FIELDS.map((f) => (
          <label key={f} className="adp-map-row">
            <span>{t(`adp.field_${f}`)}{(mapping[f]?.length || 0) > 1 && <span className="tiny faint">{' '}{t('adp.morePairs', { count: mapping[f].length - 1 })}</span>}</span>
            <select className="input sm" value={valueOf(f)} onChange={(e) => set(f, e.target.value)}>
              <option value="">{t('adp.noColumn')}</option>
              {file.header.map((h, i) => <option key={i} value={i}>{h || t('adp.columnN', { n: i + 1 })}</option>)}
            </select>
            <span className="tiny faint adp-map-sample">{sample.map((r) => shown(f).map((i) => r[i]).filter(Boolean).join(' / ')).filter(Boolean).slice(0, 2).join(' · ')}</span>
          </label>
        ))}
      </div>
      {problems.length > 0 && <div className="alert warn"><Icon name="alert" size={16} />{problems.map((p) => t(`adp.need_${p}`)).join(' ')}</div>}
      {parsed && !problems.length && (
        <div className={`alert ${parsed.punches.length ? 'info' : 'warn'}`}><Icon name={parsed.punches.length ? 'check' : 'alert'} size={16} />
          <div>{t('adp.foundPunches', { count: parsed.punches.length })}{parsed.skipped.length ? ` ${t('adp.skippedRows', { count: parsed.skipped.length })}` : ''}</div></div>
      )}
      {parsed?.skipped.length > 0 && <SkippedList skipped={parsed.skipped} />}
    </div>
  );
}

function SkippedList({ skipped }) {
  const t = useT();
  return (
    <details className="tp-help">
      <summary>{t('adp.whySkipped', { count: skipped.length })}</summary>
      <ul className="adp-skipped">
        {skipped.slice(0, 50).map((s, i) => <li key={i}><b>{t('adp.rowN', { n: s.row })}</b> {t(`adp.skip_${s.reason}`)} <span className="faint">{s.text}</span></li>)}
      </ul>
    </details>
  );
}

function PreviewStep({ preview, parsed, people, jobs, matches, setMatch, busy, onlyProblems, setOnlyProblems }) {
  const t = useT();
  const c = preview.counts;
  const unmatched = [];
  const seen = new Set();
  for (const r of preview.rows) if (!r.userId && !seen.has(r.workerKey)) { seen.add(r.workerKey); unmatched.push(r); }
  const manual = Object.keys(matches).map((k) => preview.rows.find((r) => r.workerKey === k)).filter(Boolean);
  const problem = (r) => !r.userId || !r.jobCodeId || r.noClockOut || r.status === 'duplicate' || r.status === 'fromApi' || (r.hours || 0) > 16;
  const rows = onlyProblems ? preview.rows.filter(problem) : preview.rows;
  const status = (r) => ({ new: ['ok', t('adp.statusNew')], updated: ['brand', t('adp.statusUpdated')], same: ['', t('adp.statusSame')], duplicate: ['warn', t('adp.statusDuplicate')], fromApi: ['', t('adp.statusFromApi')] }[r.status] || ['', r.status]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="adp-chips">
        <span className="badge brand">{preview.dates.length ? `${prettyDate(preview.dates[0])} – ${prettyDate(preview.dates.at(-1))}` : '—'}</span>
        <span className="badge ok">{t('adp.chipNew', { count: c.new })}</span>
        {c.updated > 0 && <span className="badge brand">{t('adp.chipUpdated', { count: c.updated })}</span>}
        {c.same > 0 && <span className="badge">{t('adp.chipSame', { count: c.same })}</span>}
        {c.unmatched > 0 && <span className="badge warn">{t('adp.chipUnmatched', { count: c.unmatched })}</span>}
        {c.overnight > 0 && <span className="badge">{t('adp.chipOvernight', { count: c.overnight })}</span>}
        {c.duplicate > 0 && <span className="badge warn">{t('adp.chipDuplicate', { count: c.duplicate })}</span>}
        {preview.removals > 0 && <span className="badge warn">{t('adp.chipReplaced', { count: preview.removals })}</span>}
        <span className="badge">{t('adp.chipHours', { h: h1(c.hours) })}</span>
      </div>
      {c.new + c.updated === 0 && !preview.removals && <div className="alert info"><Icon name="check" size={16} />{t('adp.nothingNew')}</div>}
      {c.fromApi > 0 && <div className="help">{t('adp.fromApiHelp', { count: c.fromApi })}</div>}

      {(unmatched.length > 0 || manual.length > 0) && (
        <div className="col" style={{ gap: 6 }}>
          <h3>{t('adp.whoIsWho')}</h3>
          <div className="help">{t('adp.whoIsWhoHelp')}</div>
          <div className="tp-list">
            {[...unmatched, ...manual.filter((m) => !unmatched.includes(m))].map((r) => (
              <div key={r.workerKey} className="tp-row">
                <div className="tp-who"><div style={{ fontWeight: 600 }}>{r.name}</div><div className="tiny faint">{[r.employeeId && t('adp.idN', { id: r.employeeId }), t('adp.clockInsInFile', { count: preview.rows.filter((x) => x.workerKey === r.workerKey).length })].filter(Boolean).join(' · ')}</div></div>
                <select className="input sm" disabled={busy} value={matches[r.workerKey] ?? r.userId ?? ''} onChange={(e) => setMatch(r.workerKey, e.target.value)} aria-label={t('adp.personFor', { name: r.name })}>
                  <option value="">{t('adp.notMatched')}</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="row wrap" style={{ gap: 8 }}>
        <h3 style={{ flex: 1 }}>{t('adp.clockIns')}</h3>
        <label className="check small"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />{t('adp.onlyProblems')}</label>
      </div>
      <div className="table-wrap">
        <table className="table lr-table adp-preview">
          <thead><tr><th>{t('common.date')}</th><th>{t('common.name')}</th><th>{t('adp.inOut')}</th><th>{t('adp.hrs')}</th><th>{t('common.position')}</th><th>{t('adp.status')}</th></tr></thead>
          <tbody>
            {rows.slice(0, MAX_SHOWN).map((r) => {
              const [cls, label] = status(r);
              return (
                <tr key={`${r.row}-${r.id}`}>
                  <td className="lr-stick">{prettyDate(r.date)}</td>
                  <td>{r.userId ? people.find((p) => p.id === r.userId)?.name || r.name : <span>{r.name} <span className="badge warn">{t('adp.notMatched')}</span></span>}</td>
                  <td>{r.inLocal ? <>{hm(r.inLocal)}–{r.outLocal ? hm(r.outLocal) : '?'}{r.overnight && <span className="badge" style={{ marginLeft: 4 }}>{t('adp.nextDay')}</span>}</> : <span className="faint">{t('adp.hoursOnly')}</span>}</td>
                  <td className="num">{h1(r.hours)}{r.overtimeHours > 0 && <span className="tiny faint">{' '}{t('adp.otH', { h: h1(r.overtimeHours) })}</span>}</td>
                  <td>{r.jobCodeId ? <span>{jobs[r.jobCodeId]?.name}{r.jobFrom === 'schedule' && <span className="tiny faint">{' '}{t('adp.fromSchedule')}</span>}</span> : <span className="faint">{r.department || '—'}</span>}</td>
                  <td><span className={`badge ${cls}`}>{label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_SHOWN && <div className="help">{t('adp.showingFirst', { shown: MAX_SHOWN, count: rows.length })}</div>}
      {parsed?.skipped.length > 0 && <SkippedList skipped={parsed.skipped} />}
      <div className="help">{t('adp.reimportHelp')}</div>
    </div>
  );
}
