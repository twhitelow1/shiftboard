// Smart import: Team → Import (people) and Training → Menu → Import (menu items). One wizard for both:
//   1. File     CSV, TSV, pasted cells, Excel (.xlsx), Word (.docx), PDF; read here in the browser (core/smart-import.js,
//               web/src/pdf.js). Text that isn't a table: "Read it with AI" (server/import-routes.js) or the simple reader.
//   2. Columns  each column → a field or "ignore", guessed (or as last time) and remembered (<target>.importMapping).
//   3. Check    <target>.importPreview: new / update (before → after) / unchanged / possible duplicates to decide /
//               problems; options; per-row include. Nothing is saved until Import.
//   4. Done     <target>.importApply: counts, invitations (people), failures. Importing the same file again changes nothing.
// Ask ShiftBoard opens it pre-loaded (initial: { records, fileName, source, lowConfidence }) at the preview, with what
// it read carried over; fields the AI wasn't sure of are highlighted.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { useT, translateError } from '../i18n/index.js';
import {
  readTable, readDocx, readXlsx, textRows, looksTabular, findHeaderRow, autoMap, rowsToRecords, mappingToRemember, pdfTable, pdfLines,
  menuFromText, rosterFromText, templateCsv, FIELDS, MAX_FILE_BYTES, MAX_AI_CHARS, isSensitiveHeader,
} from '../../../core/smart-import.js';
import { readWithAi } from '../import-api.js';
import { ROLE_IDS, roleLabel } from '../../../core/roles.js';
import { allergenLabel, dietaryLabel } from '../../../core/training.js';
import '../labor.css'; // .adp-drop, .adp-paste, .tp-help
import '../import.css';

const MAX_SHOWN = 300;
const STATUSES = ['check', 'new', 'update', 'problem', 'unchanged', 'skip'];
const BADGE = { new: 'ok', update: 'brand', unchanged: '', check: 'warn', problem: 'bad', skip: '' };

function downloadTemplate(target) {
  const blob = new Blob([templateCsv(target)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shiftboard-${target === 'menu' ? 'menu' : target === 'products' ? 'products' : 'team'}-template.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** A file → { rows } (a table) or { text } (anything else). */
async function readFile(f, target) {
  const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const table = (rows) => (rows && rows.length >= 2 && Math.max(...rows.map((r) => r.length)) >= 2 ? { rows } : null);
  if (['csv', 'tsv', 'txt', 'text'].includes(ext) || (!ext && /^text\//.test(f.type))) {
    const text = await f.text();
    const rows = readTable(text);
    if (looksTabular(rows, target) || (ext !== 'txt' && table(rows))) return { rows };
    return { text };
  }
  if (ext === 'xlsx') return table(readXlsx(new Uint8Array(await f.arrayBuffer()))) || { text: '' };
  if (ext === 'docx') {
    const d = readDocx(new Uint8Array(await f.arrayBuffer()));
    const best = [...d.tables].sort((a, b) => b.length - a.length).find((r) => looksTabular(r, target)) || [...d.tables].sort((a, b) => b.length - a.length)[0];
    if (best && table(best) && looksTabular(best, target)) return { rows: best };
    const tr = textRows(d.text);
    if (looksTabular(tr, target)) return { rows: tr };
    return { text: d.text };
  }
  if (ext === 'pdf') {
    if (IS_DEMO) throw Object.assign(new Error('pdf'), { key: 'smartImport.pdfInApp' });
    const { pdfToItems } = await import('../pdf.js');
    const { items } = await pdfToItems(f);
    const rows = pdfTable(items, target);
    if (rows && rows.length >= 2) return { rows };
    return { text: pdfLines(items).map((l) => l.cells.map((c) => c.text).join('  ')).join('\n') };
  }
  throw Object.assign(new Error('type'), { key: 'smartImport.unknownType' });
}

const TITLE = { menu: 'smartImport.titleMenu', employees: 'smartImport.titleEmployees', products: 'smartImport.titleProducts' };
const SUB = { menu: 'smartImport.subMenu', employees: 'smartImport.subEmployees', products: 'smartImport.subProducts' };
/** Text that isn't a table, for the product catalog: one product per line (bullets and counts dropped). */
const productsFromText = (text) => String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim()).filter((l) => l && l.length <= 80)
  .map((name, i) => ({ row: i + 1, values: { name }, present: ['name'] }));

export default function SmartImportDialog({ target, onClose, initial = null }) {
  const t = useT();
  const { call, toast, refresh } = useApp();
  const [step, setStep] = useState('file'); // file | text | columns | preview | done
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [columns, setColumns] = useState([]);
  const [rememberedUsed, setRememberedUsed] = useState(false);
  const [text, setText] = useState('');
  const [records, setRecords] = useState(null);
  const [source, setSource] = useState('file'); // file | ai | simple | paste
  const [readNote, setReadNote] = useState(null); // { kind: 'info' | 'warn' | 'bad', text }
  const [reading, setReading] = useState('');
  const [paste, setPaste] = useState('');
  const [remembered, setRemembered] = useState(null);
  const [options, setOptions] = useState({ createPositions: false, createCategories: true, blankClears: false, invite: false });
  const [decisions, setDecisions] = useState({});
  const [exclude, setExclude] = useState(() => new Set());
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => { call(`${target}.importMapping`, {}).then((m) => setRemembered(m.columns || {})).catch(() => setRemembered({})); }, [target]);
  // From Ask ShiftBoard: straight to the preview with what it read (row number → fields the AI wasn't sure of).
  const low = useMemo(() => {
    const m = new Map();
    (initial?.records || []).forEach((r, i) => { const f = initial.lowConfidence?.[i]; if (f?.length) m.set(r.row, f); });
    return m;
  }, [initial]);
  useEffect(() => {
    if (!initial?.records?.length) return;
    setFileName(initial.fileName || '');
    if (low.size) setReadNote({ kind: 'warn', text: t('smartImport.aiUnsure', { count: low.size }) });
    toPreview(initial.records, initial.source === 'ai' ? 'ai' : initial.source === 'simple' ? 'simple' : 'file');
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e) => setReadNote({ kind: 'bad', text: e?.key ? t(e.key) : t('smartImport.couldntRead', { error: translateError(e?.message || '') }) });

  const startColumns = (name, r, src) => {
    const h = Math.max(0, findHeaderRow(r, target, { min: 1 }));
    const header = r[h] || [];
    const cols = autoMap(header, target, { samples: r.slice(h + 1, h + 30), remembered });
    setFileName(name); setRows(r); setHeaderRow(h); setColumns(cols); setSource(src);
    setRememberedUsed(cols.some((c) => c.confidence === 'remembered'));
    setStep('columns');
  };
  const pick = async (f) => {
    if (!f) return;
    setReadNote(null);
    if (f.size > MAX_FILE_BYTES) { setReadNote({ kind: 'bad', text: t('smartImport.tooBig') }); return; }
    setReading(t('smartImport.reading'));
    try {
      const out = await readFile(f, target);
      if (out.rows?.length) startColumns(f.name, out.rows, 'file');
      else if (out.text?.trim()) { setFileName(f.name); setText(out.text); setStep('text'); }
      else setReadNote({ kind: 'bad', text: t('smartImport.empty') });
    } catch (e) { fail(e); } finally { setReading(''); }
  };
  const readPasted = () => {
    const r = readTable(paste);
    if (r.length >= 2 && Math.max(...r.map((x) => x.length)) >= 2) startColumns(t('smartImport.pasted'), r, 'paste');
    else if (paste.trim()) { setFileName(t('smartImport.pasted')); setText(paste); setStep('text'); }
  };

  // ----- preview -----
  const runPreview = async (recs = records, opts = options, decs = decisions) => {
    const my = ++seq.current;
    setBusy(true);
    try {
      const p = await call(`${target}.importPreview`, { records: recs, options: opts, decisions: decs });
      if (my === seq.current) { setPreview(p); setStep('preview'); }
    } catch (e) { toast(translateError(e.message), 'bad'); } finally { if (my === seq.current) setBusy(false); }
  };
  const toPreview = async (recs, src) => {
    if (!recs.length) { setReadNote({ kind: 'warn', text: t('smartImport.nothingFound') }); return; }
    setRecords(recs); setDecisions({}); setExclude(new Set()); setFilter('');
    if (src) setSource(src);
    await runPreview(recs, options, {});
  };
  const fromColumns = async () => {
    const recs = rowsToRecords(rows, headerRow, columns);
    call(`${target}.importMapping`, { columns: mappingToRemember(columns) }).catch(() => {}); // remembered for next time
    setReadNote(null);
    await toPreview(recs);
  };
  const setOption = (k, v) => { const o = { ...options, [k]: v }; setOptions(o); runPreview(records, o, decisions); };
  const decide = (key, d) => { const next = { ...decisions, [key]: d ? { ...(decisions[key] || {}), ...d } : undefined }; if (!d) delete next[key]; setDecisions(next); runPreview(records, options, next); };

  // ----- AI and the simple reader -----
  const readAi = async () => {
    setReadNote(null);
    if (IS_DEMO) { setReadNote({ kind: 'info', text: t('smartImport.aiNotSetUp') }); return; }
    if (text.length > MAX_AI_CHARS) { setReadNote({ kind: 'warn', text: t('smartImport.aiTooLong', { max: MAX_AI_CHARS.toLocaleString() }) }); return; }
    setReading(t('smartImport.reading'));
    try {
      const { records: recs } = await readWithAi(target, text, { onPart: (n, total) => setReading(total > 1 ? t('smartImport.readingPart', { n, total }) : t('smartImport.reading')) });
      if (recs.length) setReadNote({ kind: 'info', text: t('smartImport.aiFound', { count: recs.length }) });
      await toPreview(recs, 'ai');
    } catch (e) {
      const r = e.reason;
      setReadNote({ kind: r === 'cap' || r === 'no_key' || r === 'off' || r === 'plan' || r === 'demo' ? 'info' : 'bad',
        text: ['no_key', 'off', 'plan', 'demo'].includes(r) ? t('smartImport.aiNotSetUp') : r === 'cap' ? t('smartImport.aiCap') : r === 'busy' || r === 'rate' ? t('smartImport.aiBusy') : translateError(e.message) });
    } finally { setReading(''); }
  };
  const readSimple = async () => {
    const recs = target === 'menu' ? menuFromText(text) : target === 'products' ? productsFromText(text) : rosterFromText(text);
    if (recs.length) setReadNote({ kind: 'info', text: t('smartImport.simpleFound', { count: recs.length }) });
    await toPreview(recs, 'simple');
  };

  // ----- apply -----
  const toImport = preview ? preview.rows.filter((r) => (r.status === 'new' || r.status === 'update') && !exclude.has(r.key)).length : 0;
  const apply = async () => {
    setBusy(true);
    try {
      const out = await call(`${target}.importApply`, { records, options, decisions, exclude: [...exclude], fileName, source });
      setResult(out); setStep('done'); refresh();
    } catch (e) { toast(translateError(e.message), 'bad'); } finally { setBusy(false); }
  };

  const back = () => {
    if (step === 'preview') setStep(rows && source !== 'ai' && source !== 'simple' ? 'columns' : text ? 'text' : 'file');
    else setStep('file');
  };
  const mapped = new Set(columns.filter((c) => c.field).map((c) => c.field));
  const hasName = mapped.has('name') || mapped.has('firstName') || mapped.has('lastName');
  const recordCount = useMemo(() => (step === 'columns' && rows ? rowsToRecords(rows, headerRow, columns).length : 0), [step, rows, headerRow, columns]);
  const checks = preview?.counts.check || 0;

  const footer = (
    <>
      {step !== 'file' && step !== 'done' && <button className="btn" disabled={busy || !!reading} onClick={back}><Icon name="left" />{t('adp.back')}</button>}
      <span className="spacer" />
      {step === 'file' && <button className="btn" onClick={onClose}>{t('common.cancel')}</button>}
      {step === 'columns' && <button className="btn primary" disabled={busy || !hasName || !recordCount} onClick={fromColumns}>{t('smartImport.preview')}<Icon name="right" /></button>}
      {step === 'preview' && <button className="btn primary" disabled={busy || checks > 0 || !toImport} onClick={apply}><Icon name="check" />{busy ? t('smartImport.applying') : t('smartImport.apply', { count: toImport })}</button>}
      {step === 'done' && <button className="btn primary" onClick={onClose}>{t('common.done')}</button>}
    </>
  );

  return (
    <Modal wide title={t(TITLE[target])} sub={fileName || t(SUB[target])} onClose={onClose} footer={footer}>
      <ol className="si-steps" aria-label={t(TITLE[target])}>
        {[['file', 'stepFile'], ['columns', 'stepColumns'], ['preview', 'stepPreview'], ['done', 'stepDone']].map(([k, label], i) => {
          const order = { file: 0, text: 0, columns: 1, preview: 2, done: 3 };
          return <li key={k} className={order[step] === i ? 'on' : order[step] > i ? 'past' : ''}>{t(`smartImport.${label}`)}</li>;
        })}
      </ol>
      {readNote && <div className={`alert ${readNote.kind}`} style={{ marginBottom: 10 }}><Icon name={readNote.kind === 'bad' ? 'alert' : 'sparkle'} size={16} /><div>{readNote.text}</div></div>}
      {reading && <div className="alert info" style={{ marginBottom: 10 }}><Icon name="clock" size={16} />{reading}</div>}

      {step === 'file' && (
        <div className="col" style={{ gap: 12 }}>
          <div className="adp-drop si-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}>
            <Icon name="upload" size={22} />
            <div style={{ fontWeight: 700 }}>{t('smartImport.chooseFile')}</div>
            <div className="small muted">{t('smartImport.chooseHelp')}</div>
            <button className="btn primary sm" disabled={!!reading} onClick={() => inputRef.current?.click()}>{t('smartImport.pickFile')}</button>
            <input ref={inputRef} type="file" hidden accept=".csv,.tsv,.txt,.xlsx,.docx,.pdf,text/csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => downloadTemplate(target)}><Icon name="download" />{t('smartImport.template')}</button>
            <span className="tiny faint" style={{ flex: '1 1 200px' }}>{t('smartImport.templateHelp')}</span>
          </div>
          <details className="tp-help">
            <summary>{t('smartImport.orPaste')}</summary>
            <textarea className="input adp-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t('smartImport.pastePlaceholder')} aria-label={t('smartImport.orPaste')} />
            <button className="btn sm" style={{ marginTop: 6 }} disabled={!paste.trim()} onClick={readPasted}>{t('smartImport.readPasted')}</button>
          </details>
        </div>
      )}

      {step === 'text' && (
        <div className="col" style={{ gap: 12 }}>
          <h3>{t('smartImport.notATable')}</h3>
          <div className="help">{t('smartImport.notATableHelp')}</div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn primary" disabled={!!reading || busy} onClick={readAi}><Icon name="sparkle" />{t('smartImport.readWithAi')}</button>
            <button className="btn" disabled={!!reading || busy} onClick={readSimple}>{t('smartImport.readSimple')}</button>
          </div>
          <details className="tp-help">
            <summary>{t('smartImport.textPreview')}</summary>
            <pre className="si-text">{text.slice(0, 4000)}{text.length > 4000 ? '…' : ''}</pre>
          </details>
        </div>
      )}

      {step === 'columns' && (
        <ColumnsStep target={target} rows={rows} headerRow={headerRow} columns={columns} setColumns={setColumns}
          setHeaderRow={(h) => { setHeaderRow(h); setColumns(autoMap(rows[h] || [], target, { samples: rows.slice(h + 1, h + 30), remembered })); }}
          rememberedUsed={rememberedUsed} hasName={hasName} recordCount={recordCount} />
      )}

      {step === 'preview' && preview && (
        <PreviewStep target={target} preview={preview} options={options} setOption={setOption} busy={busy} filter={filter} setFilter={setFilter}
          exclude={exclude} setExclude={setExclude} decisions={decisions} decide={decide} toImport={toImport} low={low} />
      )}

      {step === 'done' && result && <DoneStep target={target} result={result} options={options} />}
    </Modal>
  );
}

const fieldLabel = (t, target, f) => t(`smartImport.f_${target}_${f}`);

function ColumnsStep({ target, rows, headerRow, columns, setColumns, setHeaderRow, rememberedUsed, hasName, recordCount }) {
  const t = useT();
  const samples = (i) => rows.slice(headerRow + 1).map((r) => r[i]).filter((v) => v && String(v).trim()).slice(0, 3);
  const setField = (i, field) => setColumns(columns.map((c) => (c.index === i ? { ...c, field: field || null, confidence: null } : field && c.field === field ? { ...c, field: null, confidence: null } : c)));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="help">{rememberedUsed ? t('smartImport.columnsRemembered') : t('smartImport.columnsHelp')}</div>
      <label className="row si-header-row">
        <span className="small">{t('smartImport.headerRow')}</span>
        <select className="input sm" value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))}>
          {rows.slice(0, 10).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter(Boolean).slice(0, 3).join(', ').slice(0, 40)}</option>)}
        </select>
      </label>
      <div className="si-columns">
        {columns.map((c) => {
          const sensitive = c.sensitive || isSensitiveHeader(c.header);
          return (
            <div key={c.index} className={`si-col ${c.field ? 'on' : ''}`}>
              <div className="si-col-head">
                <b className="si-col-name">{c.header || t('smartImport.noHeader', { n: c.index + 1 })}</b>
                {c.confidence && !sensitive && c.field && <span className={`badge ${c.confidence === 'exact' || c.confidence === 'remembered' ? 'ok' : 'warn'}`}>{t(`smartImport.conf_${c.confidence}`)}</span>}
              </div>
              <div className="tiny faint si-col-sample">{samples(c.index).length ? t('smartImport.sample', { values: samples(c.index).join(' · ') }) : '—'}</div>
              {sensitive ? <span className="badge bad">{t('smartImport.neverImported')}</span> : (
                <select className="input sm" value={c.field || ''} onChange={(e) => setField(c.index, e.target.value)} aria-label={c.header || t('smartImport.noHeader', { n: c.index + 1 })}>
                  <option value="">{t('smartImport.ignore')}</option>
                  {FIELDS[target].map((f) => <option key={f.key} value={f.key}>{fieldLabel(t, target, f.key)}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {!hasName ? <div className="alert warn"><Icon name="alert" size={16} />{t('smartImport.needName')}</div>
        : <div className="alert info"><Icon name="check" size={16} />{t('smartImport.rowsFound', { count: recordCount })}</div>}
    </div>
  );
}

function PreviewStep({ target, preview, options, setOption, busy, filter, setFilter, exclude, setExclude, decisions, decide, toImport, low }) {
  const t = useT();
  const c = preview.counts;
  const shown = preview.rows.filter((r) => !filter || r.status === filter);
  const toggle = (key) => { const s = new Set(exclude); if (s.has(key)) s.delete(key); else s.add(key); setExclude(s); };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="si-options">
        {target === 'products' ? null : target === 'employees'
          ? <label className="check small"><input type="checkbox" checked={options.createPositions} disabled={busy} onChange={(e) => setOption('createPositions', e.target.checked)} />{t('smartImport.optCreatePositions')}</label>
          : <label className="check small"><input type="checkbox" checked={options.createCategories} disabled={busy} onChange={(e) => setOption('createCategories', e.target.checked)} />{t('smartImport.optCreateCategories')}</label>}
        <label className="check small" title={t('smartImport.optBlankClearsHelp')}><input type="checkbox" checked={options.blankClears} disabled={busy} onChange={(e) => setOption('blankClears', e.target.checked)} />{t('smartImport.optBlankClears')}</label>
        {target === 'employees' && <label className="check small"><input type="checkbox" checked={options.invite} disabled={busy} onChange={(e) => setOption('invite', e.target.checked)} />{t('smartImport.optInvite')}</label>}
        {options.blankClears && <div className="tiny faint">{t('smartImport.optBlankClearsHelp')}</div>}
        {target === 'employees' && options.invite && <div className="tiny faint">{t('smartImport.optInviteHelp')}{IS_DEMO ? ` ${t('smartImport.demoInvite')}` : ''}</div>}
      </div>

      <div className="si-chips" role="tablist">
        <button className={`chip ${!filter ? 'on' : ''}`} onClick={() => setFilter('')}>{t('smartImport.filterAll')} {c.total}</button>
        {STATUSES.filter((s) => c[s]).map((s) => (
          <button key={s} className={`chip ${filter === s ? 'on' : ''} ${s === 'check' ? 'si-chip-check' : ''}`} onClick={() => setFilter(filter === s ? '' : s)}>{t(`smartImport.chip_${s}`, { count: c[s] })}</button>
        ))}
      </div>
      {c.check > 0 && <div className="alert warn"><Icon name="alert" size={16} /><div>{t('smartImport.decideFirst', { count: c.check })}</div></div>}
      {!c.check && !toImport && <div className="alert info"><Icon name="check" size={16} />{t('smartImport.nothingToImport')}</div>}

      <div className="si-rows">
        {shown.slice(0, MAX_SHOWN).map((r) => (
          <RowCard key={r.key} target={target} row={r} busy={busy} excluded={exclude.has(r.key)} onToggle={() => toggle(r.key)} decision={decisions[r.key]} decide={(d) => decide(r.key, d)}
            unsure={low?.size ? new Set(r.rows.flatMap((n) => low.get(n) || []).map((f) => FIELD_OF[f] || f)) : null} />
        ))}
      </div>
      {shown.length > MAX_SHOWN && <div className="help">{t('smartImport.showingFirst', { shown: MAX_SHOWN, count: shown.length })}</div>}
      <div className="help">{t('smartImport.again')}</div>
    </div>
  );
}

const shownValue = (t, v, field) => (v === true || v === 'true' ? t('smartImport.yes') : v === false || v === 'false' ? t('smartImport.no') : v == null || v === '' ? '—'
  : field === 'role' && ROLE_IDS.includes(v) ? roleLabel(v, t.lang)
  : field === 'allergens' ? String(v).split(', ').map((a) => allergenLabel(a, t.lang)).join(', ')
  : field === 'dietary' ? String(v).split(', ').map((d) => dietaryLabel(d, t.lang)).join(', ') : String(v));

// A column's field → the field the preview shows it as (normalized names).
const FIELD_OF = { ingredients: 'keyIngredients', selling: 'sellingNotes', recipe: 'recipeSteps', prep: 'prepNotes' };

function RowCard({ target, row: r, busy, excluded, onToggle, decision, decide, unsure = null }) {
  const t = useT();
  const mark = (f) => (unsure?.has(f) ? { className: 'si-after si-unsure', title: t('smartImport.aiUnsureField') } : { className: 'si-after' });
  const canToggle = r.status === 'new' || r.status === 'update';
  const deciding = !!(r.candidates || r.conflicts);
  const label = (f) => fieldLabel(t, target, f);
  return (
    <div className={`si-row card si-st-${r.status} ${excluded ? 'off' : ''}`}>
      <div className="si-row-head">
        {canToggle && <input type="checkbox" checked={!excluded} onChange={onToggle} aria-label={t('smartImport.include')} disabled={busy} />}
        <span className={`badge ${BADGE[r.status]}`}>{t(`smartImport.st_${r.status}`)}</span>
        <b className="si-row-name">{r.label || '—'}</b>
        <span className="tiny faint">{t('smartImport.rowN', { rows: r.rows.join(', ') })}</span>
      </div>
      {r.match && !r.candidates && <div className="small muted">{t('smartImport.matches', { name: r.match.name })} · {t(`smartImport.by_${r.match.by}`)}</div>}
      {r.changes.length > 0 && (
        <ul className="si-changes">
          {r.changes.map((ch, i) => (
            <li key={i}>
              <span className="si-field">{label(ch.field)}</span>
              <span className="si-before">{shownValue(t, ch.before, ch.field)}</span><span aria-hidden="true"> → </span><span {...mark(ch.field)}>{shownValue(t, ch.after, ch.field)}</span>
              {r.decision === 'update' && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => decide({ action: 'update', id: r.match.id, keep: [...(decision?.keep || []), ch.field] })}>{t('smartImport.keepCurrent')}</button>}
            </li>
          ))}
        </ul>
      )}
      {r.decision === 'update' && decision?.keep?.length > 0 && (
        <div className="row wrap si-kept">{decision.keep.map((f) => <button key={f} type="button" className="chip" disabled={busy} onClick={() => decide({ action: 'update', id: r.match.id, keep: decision.keep.filter((x) => x !== f) })}>{label(f)}: {t('smartImport.useFile')}</button>)}</div>
      )}
      {r.status === 'new' && !deciding && (
        <>
          <div className="small muted">{t('smartImport.newRecord')}</div>
          <ul className="si-changes si-new">
            {Object.entries(r.incoming || {}).filter(([f, v]) => f !== 'name' && v !== '' && v != null).slice(0, 8).map(([f, v]) => (
              <li key={f}><span className="si-field">{label(f)}</span><span {...mark(f)}>{shownValue(t, v, f)}</span></li>
            ))}
          </ul>
        </>
      )}
      {r.status === 'unchanged' && <div className="small muted">{t('smartImport.noChanges')}</div>}
      {r.problems.map((p, i) => <div key={`p${i}`} className="small si-problem"><Icon name="alert" size={14} />{t(`smartImport.p_${p.code}`, p.params)}</div>)}
      {r.notes.map((n, i) => <div key={`n${i}`} className="tiny faint">{t(`smartImport.n_${n.code}`, n.params)}</div>)}
      {deciding && <Decide target={target} row={r} busy={busy} decision={decision} decide={decide} />}
    </div>
  );
}

const SUMMARY_FIELDS = {
  employees: ['name', 'legalName', 'email', 'phone', 'positions', 'role', 'employeeId', 'hireDate', 'birthday', 'active'],
  menu: ['name', 'category', 'description', 'price', 'allergens', 'dietary'],
  products: ['name', 'category', 'size', 'location'],
};

/** A possible duplicate, an exact match with more than one, or rows of the file that disagree: side by side, and the choices. */
function Decide({ target, row: r, busy, decision, decide }) {
  const t = useT();
  const label = (f) => fieldLabel(t, target, f);
  const inc = r.incoming || {};
  const fields = SUMMARY_FIELDS[target].filter((f) => (r.candidates || []).some((c) => c[f] != null && c[f] !== '' && !(Array.isArray(c[f]) && !c[f].length)) || inc[f]);
  const incoming = (f) => (f === 'legalName' ? [inc.legalFirstName, inc.legalLastName].filter(Boolean).join(' ') : inc[f]);
  const val = (v, f) => shownValue(t, Array.isArray(v) ? v.join(', ') : v, f);
  const why = r.why || (r.openConflicts ? 'inFile' : null);
  return (
    <div className="si-decide">
      {r.candidates && (
        <>
          <div className="si-why"><Icon name="alert" size={14} /><b>{t(`smartImport.why_${r.why}`)}</b></div>
          <div className="tiny faint">{t(`smartImport.whyHelp_${r.why}`)}</div>
          <div className="si-compare">
            <div className="si-side">
              <div className="si-side-title">{t('smartImport.inFile')}</div>
              {fields.map((f) => <div key={f} className="si-kv"><span>{label(f)}</span><b>{val(incoming(f), f)}</b></div>)}
            </div>
            {r.candidates.map((c) => {
              const chosen = r.decision === 'update' && r.match?.id === c.id;
              return (
                <div key={c.id} className={`si-side ${chosen ? 'chosen' : ''}`}>
                  <div className="si-side-title">{t('smartImport.inShiftBoard')} · <span className={`badge ${c.confidence === 'high' ? 'warn' : ''}`}>{t(`smartImport.confidence_${c.confidence}`)}</span></div>
                  {fields.map((f) => <div key={f} className="si-kv"><span>{label(f)}</span><b>{val(c[f], f)}</b></div>)}
                  <div className="tiny faint">{t('smartImport.becauseOf', { reasons: c.reasons.map((x) => t(`smartImport.reason_${x}`)).join(', ') })}</div>
                  <button type="button" className={`btn sm ${chosen ? 'primary' : ''}`} disabled={busy} onClick={() => decide({ action: 'update', id: c.id, keep: [] })}><Icon name="check" size={14} />{t('smartImport.updateThis')}</button>
                </div>
              );
            })}
          </div>
          <div className="row wrap si-choices">
            <button type="button" className={`btn sm ${r.decision === 'skip' ? 'primary' : ''}`} disabled={busy} onClick={() => decide({ action: 'skip', id: null, keep: [] })}>{t('smartImport.skipIt')}</button>
            <button type="button" className={`btn sm ${r.decision === 'new' ? 'primary' : ''}`} disabled={busy} onClick={() => decide({ action: 'new', id: null, keep: [] })}><Icon name="plus" size={14} />{t('smartImport.createNew')}</button>
            {r.decision && <span className="small si-decided">{r.decision === 'update' ? t('smartImport.decided_update', { name: r.match?.name || '' }) : t(`smartImport.decided_${r.decision}`)}{r.remembered ? ` · ${t('smartImport.rememberedDecision')}` : ''}</span>}
          </div>
        </>
      )}
      {r.conflicts && Object.keys(r.conflicts).length > 0 && (
        <div className="si-conflicts">
          {(why === 'inFile' || r.openConflicts) && <div className="si-why"><Icon name="alert" size={14} /><b>{t('smartImport.why_inFile')}</b></div>}
          {Object.entries(r.conflicts).map(([f, opts]) => (
            <div key={f} className="si-conflict" role="radiogroup" aria-label={t('smartImport.pickValue', { field: label(f) })}>
              <span className="si-field">{label(f)}</span>
              {opts.map((o, i) => {
                const on = r.picked && f in r.picked && JSON.stringify(r.picked[f]) === JSON.stringify(o);
                return <button key={i} type="button" role="radio" aria-checked={on} className={`chip ${on ? 'on' : ''}`} disabled={busy}
                  onClick={() => decide({ ...(decision || {}), values: { ...(decision?.values || {}), [f]: o } })}>{val(o)}</button>;
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DoneStep({ target, result: r, options }) {
  const t = useT();
  const inv = r.invited;
  return (
    <div className="col" style={{ gap: 10 }}>
      <h3 className="row" style={{ gap: 6 }}><Icon name="check" size={18} />{t('smartImport.doneTitle')}</h3>
      <div className="si-chips">
        <span className="badge ok">{t('smartImport.done_created', { count: r.created })}</span>
        <span className="badge brand">{t('smartImport.done_updated', { count: r.updated })}</span>
        <span className="badge">{t('smartImport.done_unchanged', { count: r.unchanged })}</span>
        {r.skipped > 0 && <span className="badge">{t('smartImport.done_skipped', { count: r.skipped })}</span>}
        {r.failed.length > 0 && <span className="badge bad">{t('smartImport.done_failed', { count: r.failed.length })}</span>}
      </div>
      {r.positionsCreated?.length > 0 && <div className="small">{t('smartImport.done_positions', { names: r.positionsCreated.join(', ') })}</div>}
      {r.categoriesCreated?.length > 0 && <div className="small">{t('smartImport.done_categories', { names: r.categoriesCreated.join(', ') })}</div>}
      {r.failed.length > 0 && <ul className="si-failed">{r.failed.map((f) => <li key={f.key}><b>{t('smartImport.rowN', { rows: f.row })}</b> {f.label}: {translateError(f.error)}</li>)}</ul>}
      {target === 'employees' && (
        options.invite
          ? <div className="small">{inv ? t('smartImport.invitedLine', { count: inv.sent }) : IS_DEMO ? t('smartImport.demoInvite') : ''}{inv?.noEmail ? ` ${t('smartImport.invitedNoEmail', { count: inv.noEmail })}` : ''}</div>
          : r.created > 0 && <div className="small muted">{t('smartImport.notInvited')}</div>
      )}
      <div className="help">{t('smartImport.again')}</div>
    </div>
  );
}
