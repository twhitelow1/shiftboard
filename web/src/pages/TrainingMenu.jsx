// Menu study guide: browse by section, search, filter out allergens, a swipeable photo gallery, study
// flashcards, and (managers) the item editor with photo upload. UI words are in training-strings.js.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty, useAction } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { localizeItem, categoryLabel, dietaryLabel, DIETARY_TAGS, MAJOR_ALLERGENS, FIELD_GROUPS, PHOTOS_PER_ITEM } from '../../../core/training.js';
import { Photo, TIcon, Chips, LangTabs, photoFromFile, useT, useLang } from './TrainingShared.jsx';

const money = (n) => (n == null || n === '' ? '' : `$${Number(n) % 1 ? Number(n).toFixed(2) : Number(n)}`);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** The menu as the viewer reads it: names, sections and allergens in their language. */
function useMenu() {
  const { call, version } = useApp();
  const lang = useLang();
  const [data, setData] = useState(null);
  const load = () => call('menu.list').then(setData);
  useEffect(() => { load(); }, [version]);
  const view = useMemo(() => {
    if (!data) return null;
    const allergen = Object.fromEntries(data.allergens.map((a) => [a.id, lang === 'es' ? a.es : a.label]));
    const cat = (c) => categoryLabel(c, lang, data.categoryEs);
    return { ...data, allergenName: (id) => allergen[id] || id, cat, items: data.items.map((it) => ({ raw: it, ...localizeItem(it, lang) })) };
  }, [data, lang]);
  return [view, load];
}

export function MenuGuide() {
  const { isMgr } = useApp();
  const t = useT();
  const lang = useLang();
  const [menu, reload] = useMenu();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [without, setWithout] = useState([]);
  const [diet, setDiet] = useState([]);
  const [hide86, setHide86] = useState(false);
  const [filters, setFilters] = useState(false);
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null);
  if (!menu) return <div className="empty">{t.loading}</div>;

  const words = norm(q).split(/\s+/).filter(Boolean);
  const shown = menu.items.filter((it) => {
    if (cat && it.category !== cat) return false;
    if (hide86 && it.eightySixed) return false;
    if (without.some((a) => it.allergens.includes(a))) return false;
    if (diet.some((d) => !it.dietary.includes(d))) return false;
    if (!words.length) return true;
    const hay = norm([it.name, it.raw.name, it.description, it.raw.description, menu.cat(it.category), ...it.keyIngredients, ...it.raw.keyIngredients].join(' '));
    return words.every((w) => hay.includes(w));
  });
  const groups = menu.categories.map((c) => [c, shown.filter((it) => it.category === c)]).filter(([, l]) => l.length);
  const activeFilters = without.length + diet.length + (hide86 ? 1 : 0);
  const openItem = open && menu.items.find((x) => x.id === open);

  return (
    <div>
      <div className="tr-toolbar">
        <label className="tr-search"><TIcon name="search" /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.searchMenu} aria-label={t.searchMenu} /></label>
        <button className={`btn ${activeFilters ? 'primary' : ''}`} onClick={() => setFilters(!filters)} aria-expanded={filters}><TIcon name="filter" />{t.filters}{activeFilters ? ` (${activeFilters})` : ''}</button>
        <a className="btn" href="#/training/study"><TIcon name="cards" />{t.study}</a>
        {isMgr && <button className="btn primary" onClick={() => setEditing({})}><Icon name="plus" />{t.addItem}</button>}
      </div>
      {filters && (
        <div className="card card-pad tr-filters">
          <div className="tr-kicker">{t.withoutAllergens}</div>
          <Chips options={menu.allergens.map((a) => ({ id: a.id, label: menu.allergenName(a.id) }))} value={without} onChange={setWithout} />
          <div className="tr-kicker">{t.onlyDietary}</div>
          <Chips options={menu.dietary.map((d) => ({ id: d, label: dietaryLabel(d, lang) }))} value={diet} onChange={setDiet} />
          <label className="check small"><input type="checkbox" checked={hide86} onChange={(e) => setHide86(e.target.checked)} />{t.hide86}</label>
          {activeFilters > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => { setWithout([]); setDiet([]); setHide86(false); }}>{t.clearFilters}</button>}
        </div>
      )}
      <div className="tr-cats" role="tablist">
        <button className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>{t.all}</button>
        {menu.categories.map((c) => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>{menu.cat(c)}</button>)}
      </div>
      {without.length > 0 && <div className="small muted" style={{ margin: '0 2px 10px' }}>{t.showingWithout(without.map(menu.allergenName).join(', '))}</div>}

      {!menu.items.length && <div className="card"><Empty icon="star" title={t.noItemsYet}>{isMgr ? t.noItemsMgr : t.noItemsStaff}</Empty></div>}
      {menu.items.length > 0 && !shown.length && <div className="card"><Empty icon="star" title={t.nothingMatches} /></div>}
      {groups.map(([c, list]) => (
        <div key={c} className="section">
          <div className="tr-cat-title">{menu.cat(c)}<span className="faint"> · {list.length}</span></div>
          <div className="tr-grid">
            {list.map((it) => <ItemCard key={it.id} it={it} menu={menu} onClick={() => setOpen(it.id)} />)}
          </div>
        </div>
      ))}
      {openItem && <ItemDetail it={openItem} menu={menu} onClose={() => setOpen(null)} onEdit={isMgr ? () => { setEditing(openItem.raw); setOpen(null); } : null} />}
      {editing && <ItemEditor item={editing} menu={menu} onClose={(changed) => { setEditing(null); if (changed) reload(); }} />}
    </div>
  );
}
function ItemCard({ it, menu, onClick }) {
  const t = useT();
  return (
    <button type="button" className={`tr-item ${it.eightySixed ? 'is86' : ''}`} onClick={onClick}>
      <div className="tr-item-photo">
        {it.photos[0] ? <Photo id={it.photos[0].id} alt={it.name} /> : <div className="tr-photo-ph"><TIcon name="camera" size={24} /></div>}
        {it.eightySixed && <span className="tr-86">{t.eightySixed}</span>}
        {it.photos.length > 1 && <span className="tr-count">{it.photos.length}</span>}
      </div>
      <div className="tr-item-body">
        <div className="tr-item-name">{it.name}</div>
        {it.price != null && <div className="tiny muted num">{money(it.price)}</div>}
        {it.allergens.length > 0 && <div className="tr-allergen-line">{it.allergens.map(menu.allergenName).join(' · ')}</div>}
      </div>
    </button>
  );
}

function ItemDetail({ it, menu, onClose, onEdit }) {
  const t = useT();
  const lang = useLang();
  return (
    <Modal wide title={it.name} sub={[menu.cat(it.category), money(it.price)].filter(Boolean).join(' · ')} onClose={onClose}
      footer={onEdit ? <><button className="btn" onClick={onEdit}><Icon name="edit" />{t.edit}</button><span className="spacer" /><button className="btn" onClick={onClose}>{t.close}</button></> : null}>
      {it.photos.length > 0 && <Gallery photos={it.photos} name={it.name} />}
      {it.eightySixed && <div className="alert bad"><Icon name="alert" size={16} />{t.is86}</div>}
      {it.description && <div className="tr-desc">{it.description}</div>}
      <div className="tr-facts">
        <div>
          <div className="tr-kicker">{t.allergens}</div>
          {it.allergens.length ? <div className="row wrap" style={{ gap: 6 }}>{it.allergens.map((a) => <span key={a} className="badge bad">{menu.allergenName(a)}</span>)}</div>
            : <div className="small muted">{t.noMajorAllergens}</div>}
        </div>
        {it.dietary.length > 0 && (
          <div>
            <div className="tr-kicker">{t.dietary}</div>
            <div className="row wrap" style={{ gap: 6 }}>{it.dietary.map((d) => <span key={d} className="badge ok">{dietaryLabel(d, lang)}</span>)}</div>
          </div>
        )}
        {it.keyIngredients.length > 0 && (
          <div>
            <div className="tr-kicker">{t.whatsInIt}</div>
            <div>{it.keyIngredients.join(', ')}</div>
          </div>
        )}
      </div>
      {it.selling && (it.selling.notes || it.selling.pairings) && (
        <section className="tr-group">
          <h3>{t.groupName.selling}</h3>
          {it.selling.notes && <p className="tr-pre">{it.selling.notes}</p>}
          {it.selling.pairings && <p><b>{t.pairings}:</b> {it.selling.pairings}</p>}
        </section>
      )}
      {it.recipe && (it.recipe.ingredients.length > 0 || it.recipe.steps.length > 0) && (
        <section className="tr-group">
          <h3>{t.groupName.recipe}{it.recipe.yield ? <span className="small muted"> · {it.recipe.yield}</span> : null}</h3>
          {it.recipe.ingredients.length > 0 && (
            <table className="tr-recipe"><tbody>{it.recipe.ingredients.map((r, i) => <tr key={i}><td className="num">{r.qty}</td><td>{r.item}</td></tr>)}</tbody></table>
          )}
          {it.recipe.steps.length > 0 && <ol className="tr-steps">{it.recipe.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
        </section>
      )}
      {it.prep?.notes && <section className="tr-group"><h3>{t.groupName.prep}</h3><p className="tr-pre">{it.prep.notes}</p></section>}
      {(!it.can.recipe || !it.can.prep) && <div className="small muted row"><TIcon name="lock" size={14} />{t.lockedGroups}</div>}
    </Modal>
  );
}

/** Big photos, one per screen width: swipe on phones, arrows on computers, tap for full screen. */
function Gallery({ photos, name, full = false, start = 0, onTap }) {
  const ref = useRef(null);
  const [i, setI] = useState(start);
  const t = useT();
  useEffect(() => { const el = ref.current; if (el && start) el.scrollLeft = start * el.clientWidth; }, []);
  const go = (n) => { const el = ref.current; if (el) el.scrollTo({ left: Math.max(0, Math.min(photos.length - 1, n)) * el.clientWidth, behavior: 'smooth' }); };
  const [big, setBig] = useState(false);
  return (
    <div className={`tr-gallery ${full ? 'full' : ''}`}>
      <div className="tr-gallery-track" ref={ref} onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}>
        {photos.map((p, k) => <div key={p.id} className="tr-slide"><Photo id={p.id} alt={`${name} ${k + 1}`} onClick={() => (full ? onTap?.() : setBig(true))} /></div>)}
      </div>
      {photos.length > 1 && <>
        <button type="button" className="tr-gal-btn prev" onClick={() => go(i - 1)} disabled={i === 0} aria-label={t.previous}><Icon name="left" /></button>
        <button type="button" className="tr-gal-btn next" onClick={() => go(i + 1)} disabled={i === photos.length - 1} aria-label={t.next}><Icon name="right" /></button>
        <div className="tr-dots">{photos.map((p, k) => <button key={p.id} type="button" className={k === i ? 'on' : ''} onClick={() => go(k)} aria-label={`${k + 1}`} />)}</div>
      </>}
      {!full && <button type="button" className="tr-gal-full" onClick={() => setBig(true)} aria-label={t.fullScreen}><TIcon name="expand" /></button>}
      {big && <Lightbox photos={photos} name={name} start={i} onClose={() => setBig(false)} />}
    </div>
  );
}
function Lightbox({ photos, name, start, onClose }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="tr-lightbox" role="dialog" aria-modal="true" aria-label={name}>
      <button type="button" className="tr-lightbox-close" onClick={onClose} aria-label={t.close}><Icon name="x" /></button>
      <Gallery photos={photos} name={name} full start={start} onTap={onClose} />
    </div>
  );
}

// ---------- study mode ----------
export function StudyMode() {
  const t = useT();
  const lang = useLang();
  const [menu] = useMenu();
  const [mode, setMode] = useState('photo');
  const [cat, setCat] = useState('');
  const [seed, setSeed] = useState(0);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const touch = useRef(null);
  const deck = useMemo(() => {
    if (!menu) return [];
    let cards = menu.items.filter((it) => !it.eightySixed && (!cat || it.category === cat) && (mode !== 'photo' || it.photos.length));
    if (seed) cards = cards.map((c) => [Math.random(), c]).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    return cards;
  }, [menu, mode, cat, seed]);
  useEffect(() => { setI(0); setFlipped(false); }, [mode, cat, seed]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === ' ') { e.preventDefault(); setFlipped((f) => !f); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!menu) return <div className="empty">{t.loading}</div>;
  const card = deck[Math.min(i, deck.length - 1)];
  function move(d) { setFlipped(false); setI((x) => Math.max(0, Math.min(deck.length - 1, x + d))); }
  const onTouchStart = (e) => { touch.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    const dx = e.changedTouches[0].clientX - (touch.current ?? e.changedTouches[0].clientX);
    if (Math.abs(dx) > 50) move(dx < 0 ? 1 : -1);
  };

  return (
    <div className="tr-study">
      <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
        <a className="btn sm ghost" href="#/training/menu"><Icon name="left" />{t.backToMenu}</a>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setSeed((s) => s + 1)}><TIcon name="shuffle" />{t.shuffle}</button>
      </div>
      <div className="seg tr-seg-wrap" style={{ marginBottom: 8 }}>
        {[['photo', t.studyPhoto], ['allergens', t.studyAllergens], ['ingredients', t.studyIngredients]].map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}
      </div>
      <div className="tr-cats">
        <button className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>{t.all}</button>
        {menu.categories.map((c) => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>{menu.cat(c)}</button>)}
      </div>
      {!card ? <div className="card"><Empty icon="star" title={mode === 'photo' ? t.noPhotosToStudy : t.noItemsYet} /></div> : <>
        <div className={`tr-flash ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped(!flipped)} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          role="button" tabIndex={0} aria-label={flipped ? t.showQuestion : t.showAnswer}>
          {!flipped ? (
            <div className="tr-flash-face">
              {mode === 'photo' ? <Photo id={card.photos[0].id} alt="" className="tr-flash-photo" /> : <>
                <div className="tr-flash-big">{card.name}</div>
                <div className="muted">{menu.cat(card.category)}</div>
                <div className="tr-flash-q">{mode === 'allergens' ? t.qAllergens : t.qIngredients}</div>
              </>}
              <div className="tr-flash-hint">{t.tapToFlip}</div>
            </div>
          ) : (
            <div className="tr-flash-face back">
              {mode === 'photo' && <><div className="tr-flash-big">{card.name}</div><div className="muted">{menu.cat(card.category)}</div>{card.description && <div className="small tr-flash-desc">{card.description}</div>}</>}
              {mode === 'allergens' && <>
                <div className="tr-flash-title">{card.name}</div>
                {card.allergens.length ? <div className="row wrap" style={{ gap: 6, justifyContent: 'center' }}>{card.allergens.map((a) => <span key={a} className="badge bad tr-big-badge">{menu.allergenName(a)}</span>)}</div>
                  : <div className="tr-flash-big small-big">{t.noMajorAllergens}</div>}
                {card.dietary.length > 0 && <div className="small muted">{card.dietary.map((d) => dietaryLabel(d, lang)).join(' · ')}</div>}
              </>}
              {mode === 'ingredients' && <>
                <div className="tr-flash-title">{card.name}</div>
                <div className="tr-flash-list">{card.keyIngredients.length ? card.keyIngredients.join(', ') : t.noIngredientsListed}</div>
              </>}
            </div>
          )}
        </div>
        <div className="tr-flash-nav">
          <button className="btn" onClick={() => move(-1)} disabled={i === 0}><Icon name="left" />{t.previous}</button>
          <span className="small muted num">{Math.min(i, deck.length - 1) + 1} / {deck.length}</span>
          <button className="btn primary" onClick={() => move(1)} disabled={i >= deck.length - 1}>{t.next}<Icon name="right" /></button>
        </div>
        <div className="help" style={{ textAlign: 'center' }}>{t.swipeHelp}</div>
      </>}
    </div>
  );
}

// ---------- editor (managers) ----------
const blankRecipe = () => ({ yield: '', ingredients: [], steps: [] });
function toForm(item) {
  const side = (x = {}) => ({
    name: x.name || '', description: x.description || '', keyText: (x.keyIngredients || []).join(', '),
    selling: { notes: '', pairings: '', ...(x.selling || {}) }, recipe: { ...blankRecipe(), ...(x.recipe || {}) }, prep: { notes: '', ...(x.prep || {}) },
  });
  const majors = new Set(MAJOR_ALLERGENS.map((a) => a.id));
  return {
    id: item.id, category: item.category || '', price: item.price ?? '', eightySixed: !!item.eightySixed,
    allergens: (item.allergens || []).filter((a) => majors.has(a)), otherAllergens: (item.allergens || []).filter((a) => !majors.has(a)).join(', '),
    dietary: (item.dietary || []).filter((d) => DIETARY_TAGS.includes(d)), otherDietary: (item.dietary || []).filter((d) => !DIETARY_TAGS.includes(d)).join(', '),
    visibility: item.visibility || {}, photos: item.photos || [],
    ...side(item), stepsText: (item.recipe?.steps || []).join('\n'),
    es: { ...side(item.es), stepsText: (item.es?.recipe?.steps || []).join('\n') },
  };
}
const fromSide = (x) => ({
  name: x.name, description: x.description, keyIngredients: x.keyText.split(',').map((s) => s.trim()).filter(Boolean),
  selling: x.selling, recipe: { ...x.recipe, steps: x.stepsText.split('\n').map((s) => s.trim()).filter(Boolean) }, prep: x.prep,
});

function ItemEditor({ item, menu, onClose }) {
  const { call, jobCodes } = useApp();
  const t = useT();
  const lang = useLang();
  const [f, setF] = useState(() => toForm(item));
  const [edLang, setEdLang] = useState('en');
  const [run, busy] = useAction();
  const [sure, setSure] = useState(false);
  const [changed, setChanged] = useState(false);
  const side = edLang === 'es' ? f.es : f;
  const setSide = (patch) => setF((x) => (edLang === 'es' ? { ...x, es: { ...x.es, ...patch } } : { ...x, ...patch }));

  const save = async () => {
    const payload = {
      id: f.id, category: f.category, price: f.price, eightySixed: f.eightySixed, visibility: f.visibility,
      allergens: [...f.allergens, ...f.otherAllergens.split(',')].map((s) => s.trim()).filter(Boolean),
      dietary: [...f.dietary, ...f.otherDietary.split(',')].map((s) => s.trim()).filter(Boolean),
      ...fromSide(f), es: fromSide(f.es),
    };
    const r = await run(() => call('menu.save', payload), t.saved);
    if (r) { setChanged(true); setF((x) => ({ ...x, id: r.id, photos: r.photos })); if (f.id) onClose(true); }
  };
  const del = async () => {
    if (!sure) return setSure(true);
    const r = await run(() => call('menu.delete', { id: f.id }), t.deleted);
    if (r) onClose(true);
  };
  const ruleText = (r) => (r?.all ? t.everyone : [...(r?.departments || []), ...(r?.jobCodeIds || []).map((id) => jobCodes.find((j) => j.id === id)?.name).filter(Boolean)].join(', ') || t.managersOnly);

  return (
    <Modal wide title={f.id ? t.editItem : t.addItem} onClose={() => onClose(changed)}
      footer={<>
        {f.id && <button className={`btn danger ${sure ? 'solid' : ''}`} onClick={del} disabled={busy}><Icon name="trash" />{sure ? t.tapAgainToDelete : t.delete}</button>}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(changed)}>{t.cancel}</button>
        <button className="btn primary" onClick={save} disabled={busy}>{f.id ? t.save : t.saveAndAddPhotos}</button>
      </>}>
      <div className="row wrap tr-ed-lang"><LangTabs value={edLang} onChange={setEdLang} /><span className="help">{edLang === 'es' ? t.spanishHelp : t.englishHelp}</span></div>

      <div className="tr-kicker">{t.basics}</div>
      <div className="grid2">
        <Field label={edLang === 'es' ? t.nameEs : t.name}><input className="input" value={side.name} onChange={(e) => setSide({ name: e.target.value })} placeholder={edLang === 'es' ? f.name : ''} /></Field>
        <div className="grid2">
          <Field label={t.section}>
            <input className="input" list="tr-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
            <datalist id="tr-cats">{(menu.suggestedCategories || menu.categories).map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label={t.price}><input className="input" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="$" /></Field>
        </div>
      </div>
      <Field label={t.description}><textarea className="input" rows="3" value={side.description} onChange={(e) => setSide({ description: e.target.value })} /></Field>
      <Field label={t.keyIngredients} help={t.keyIngredientsHelp}><input className="input" value={side.keyText} onChange={(e) => setSide({ keyText: e.target.value })} /></Field>
      <Field label={t.allergens}>
        <Chips options={MAJOR_ALLERGENS.map((a) => ({ id: a.id, label: lang === 'es' ? a.es : a.label }))} value={f.allergens} onChange={(v) => setF({ ...f, allergens: v })} />
        <input className="input" value={f.otherAllergens} onChange={(e) => setF({ ...f, otherAllergens: e.target.value })} placeholder={t.otherAllergens} style={{ marginTop: 6 }} />
      </Field>
      <Field label={t.dietary}>
        <Chips options={DIETARY_TAGS.map((d) => ({ id: d, label: dietaryLabel(d, lang) }))} value={f.dietary} onChange={(v) => setF({ ...f, dietary: v })} />
        <input className="input" value={f.otherDietary} onChange={(e) => setF({ ...f, otherDietary: e.target.value })} placeholder={t.otherDietary} style={{ marginTop: 6 }} />
      </Field>
      <label className="check"><input type="checkbox" checked={f.eightySixed} onChange={(e) => setF({ ...f, eightySixed: e.target.checked })} />{t.mark86}</label>

      <div className="tr-kicker">{t.groupName.selling}</div>
      <Field label={t.sellingNotes}><textarea className="input" rows="3" value={side.selling.notes} onChange={(e) => setSide({ selling: { ...side.selling, notes: e.target.value } })} placeholder={t.sellingPlaceholder} /></Field>
      <Field label={t.pairings}><input className="input" value={side.selling.pairings} onChange={(e) => setSide({ selling: { ...side.selling, pairings: e.target.value } })} /></Field>

      <div className="tr-kicker">{t.groupName.recipe}</div>
      <Field label={t.yield}><input className="input" value={side.recipe.yield} onChange={(e) => setSide({ recipe: { ...side.recipe, yield: e.target.value } })} placeholder={t.yieldPlaceholder} /></Field>
      <Field label={t.ingredients}>
        <IngredientRows rows={side.recipe.ingredients} onChange={(rows) => setSide({ recipe: { ...side.recipe, ingredients: rows } })} />
        {edLang === 'es' && !side.recipe.ingredients.length && f.recipe.ingredients.length > 0 && (
          <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSide({ recipe: { ...side.recipe, ingredients: f.recipe.ingredients.map((r) => ({ ...r })) } })}>{t.copyFromEnglish}</button>
        )}
      </Field>
      <Field label={t.steps} help={t.stepsHelp}><textarea className="input" rows="4" value={side.stepsText} onChange={(e) => setSide({ stepsText: e.target.value })} /></Field>
      <div className="tr-kicker">{t.groupName.prep}</div>
      <Field label={t.prepNotes}><textarea className="input" rows="3" value={side.prep.notes} onChange={(e) => setSide({ prep: { ...side.prep, notes: e.target.value } })} /></Field>

      <div className="tr-kicker">{t.whoSees}</div>
      <div className="help" style={{ marginTop: -6 }}>{t.whoSeesHelp}</div>
      {FIELD_GROUPS.map((g) => {
        const r = f.visibility[g];
        const mode = !r ? 'default' : r.all ? 'all' : 'some';
        const setRule = (next) => setF({ ...f, visibility: { ...f.visibility, [g]: next } });
        return (
          <div key={g} className="tr-vis">
            <div className="tr-vis-head"><b>{t.groupName[g]}</b>
              <select className="input sm" value={mode} onChange={(e) => setRule(e.target.value === 'default' ? null : e.target.value === 'all' ? { all: true } : { departments: [], jobCodeIds: [] })}>
                <option value="default">{t.restaurantDefault(ruleText(menu.defaults?.[g]))}</option>
                <option value="all">{t.everyone}</option>
                <option value="some">{t.onlySome}</option>
              </select>
            </div>
            {mode === 'some' && <>
              <Chips options={menu.departments || []} value={r.departments || []} onChange={(v) => setRule({ ...r, departments: v })} />
              <Chips options={jobCodes.filter((j) => !j.archived).map((j) => ({ id: j.id, label: j.name }))} value={r.jobCodeIds || []} onChange={(v) => setRule({ ...r, jobCodeIds: v })} />
            </>}
          </div>
        );
      })}

      <div className="tr-kicker">{t.photos}</div>
      {f.id ? <PhotoManager itemId={f.id} photos={f.photos} name={f.name} onChange={(photos) => { setF((x) => ({ ...x, photos })); setChanged(true); }} />
        : <div className="help">{t.saveFirstForPhotos}</div>}
      {busy && <div className="small muted">{t.saving}</div>}
    </Modal>
  );
}

function IngredientRows({ rows, onChange }) {
  const t = useT();
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="col" style={{ gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} className="tr-ing-row">
          <input className="input sm" value={r.qty} onChange={(e) => set(i, 'qty', e.target.value)} placeholder={t.amount} aria-label={t.amount} />
          <input className="input sm" value={r.item} onChange={(e) => set(i, 'item', e.target.value)} placeholder={t.ingredient} aria-label={t.ingredient} />
          <button type="button" className="btn sm icon ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={t.remove}><Icon name="x" /></button>
        </div>
      ))}
      <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...rows, { qty: '', item: '' }])}><Icon name="plus" />{t.addIngredient}</button>
    </div>
  );
}

/** Upload (resized in the browser, one per request), reorder and delete an item's photos. */
function PhotoManager({ itemId, photos, name, onChange }) {
  const { call, toast } = useApp();
  const t = useT();
  const [busy, setBusy] = useState('');
  const upload = async (files) => {
    let list = photos;
    const todo = [...files].slice(0, Math.max(0, PHOTOS_PER_ITEM - photos.length));
    if (files.length > todo.length) toast(t.photoLimit(PHOTOS_PER_ITEM), 'bad');
    for (let k = 0; k < todo.length; k++) {
      setBusy(t.uploading(k + 1, todo.length));
      try {
        const { dataUrl, w, h } = await photoFromFile(todo[k]);
        const r = await call('menu.addPhoto', { itemId, dataUrl, w, h });
        list = r.photos;
        onChange(list);
      } catch (e) {
        toast(e.message === 'bad' ? t.notAnImage : e.message === 'big' ? t.photoTooBig : e.message, 'bad');
      }
    }
    setBusy('');
  };
  const move = async (i, d) => {
    const ids = photos.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try { onChange((await call('menu.reorderPhotos', { itemId, photoIds: ids })).photos); } catch (e) { toast(e.message, 'bad'); }
  };
  const remove = async (id) => {
    try { onChange((await call('menu.removePhoto', { itemId, photoId: id })).photos); } catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      {photos.length > 0 && (
        <div className="tr-thumbs">
          {photos.map((p, i) => (
            <div key={p.id} className="tr-thumb">
              <Photo id={p.id} alt={`${name} ${i + 1}`} />
              {i === 0 && <span className="tr-thumb-main">{t.mainPhoto}</span>}
              <div className="tr-thumb-bar">
                <button type="button" className="btn sm icon" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} aria-label={t.moveLeft}><Icon name="left" /></button>
                <button type="button" className="btn sm icon danger" disabled={!!busy} onClick={() => remove(p.id)} aria-label={t.delete}><Icon name="trash" /></button>
                <button type="button" className="btn sm icon" disabled={i === photos.length - 1 || !!busy} onClick={() => move(i, 1)} aria-label={t.moveRight}><Icon name="right" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {IS_DEMO ? <div className="help">{t.demoNoUpload}</div> : (
        <div className="row wrap">
          <label className={`btn sm primary ${busy || photos.length >= PHOTOS_PER_ITEM ? 'disabled' : ''}`}>
            <TIcon name="camera" />{busy || t.addPhotos}
            <input type="file" accept="image/*" multiple hidden disabled={!!busy || photos.length >= PHOTOS_PER_ITEM} onChange={(e) => { upload(e.target.files || []); e.target.value = ''; }} />
          </label>
          <span className="help">{t.photoHelp(PHOTOS_PER_ITEM)}</span>
        </div>
      )}
    </div>
  );
}
