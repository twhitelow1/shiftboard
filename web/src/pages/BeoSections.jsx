// A BEO's details as sections (core/beo-sections.js): on the event's page and in the import preview. Only what the
// BEO (or a manager) said shows: a section with nothing in it isn't drawn, and neither is a label without a value.
// The BEO's own words are shown as written; the app's labels are translated. Dietary and allergy notes stand out.
import React from 'react';
import { Icon } from '../ui.jsx';
import { visibleSections, PRIVATE_SECTIONS } from '../../../core/beo-sections.js';
import { useT, fmtTime } from '../i18n/index.js';
import '../beo.css';

const timeText = (a, b) => (a ? `${fmtTime(a)}${b ? `–${fmtTime(b)}` : ''}` : '');
const BULLET = /^[•◦▪●○*–-]\s*/;
/** A section's name: the app's for the ones it knows, the BEO's own heading for anything else. */
export function sectionTitle(t, s) {
  return s.key === 'other' ? s.title || t('beo.section_other') : t(`beo.section_${s.key}`);
}

/** The sections one person sees (client: managers and the events team), each in its own card. */
export default function BeoSections({ e, client }) {
  const t = useT();
  const sections = visibleSections(e, { client });
  if (!sections.length) return null;
  return sections.map((s, i) => (
    <section key={`${s.key}-${i}`} id={s.key === 'dietary' ? 'beo-dietary' : undefined}
      className={`card card-pad beo-sec beo-sec-${s.key}${s.key === 'dietary' ? ' beo-sec-alert' : ''}`}>
      <h2 className="beo-sec-h">
        {s.key === 'dietary' && <Icon name="alert" size={16} />}
        <span>{sectionTitle(t, s)}</span>
        {PRIVATE_SECTIONS.includes(s.key) && <span className="badge beo-sec-private" title={t('beo.privateHelp')}><Icon name="lock" size={11} />{t('beo.private')}</span>}
      </h2>
      <SectionBody s={s} />
    </section>
  ));
}

export function SectionBody({ s }) {
  const t = useT();
  if (s.kind === 'timeline') {
    return (
      <ol className="beo-tl">
        {s.items.map((x, i) => <li key={i}><b className="num">{timeText(x.time, x.end)}</b><span>{x.text}</span></li>)}
      </ol>
    );
  }
  if (s.kind === 'menu') {
    return (
      <div className="beo-menu">
        {s.items.map((m, i) => (
          <div key={i} className="beo-menu-row">
            {m.course && m.course !== s.items[i - 1]?.course && <div className="beo-menu-course">{m.course}</div>}
            {m.item && (
              <div className="beo-menu-item">
                {m.item}
                {m.qty ? <span className="muted"> ×{m.qty}</span> : null}
                {(m.dietary || []).map((d) => <span key={d} className="badge beo-diet">{d}</span>)}
              </div>
            )}
            {m.notes && <div className="small muted">{m.notes}</div>}
          </div>
        ))}
      </div>
    );
  }
  if (s.kind === 'keyvalue') {
    const labelled = s.items.filter((x) => x.labelKey || x.label);
    const plain = s.items.filter((x) => !x.labelKey && !x.label);
    return (
      <>
        {labelled.length > 0 && (
          <dl className="kv beo-kv">
            {labelled.map((x, i) => (
              <React.Fragment key={i}>
                <dt>{x.labelKey ? t(`beo.label_${x.labelKey}`) : x.label}</dt>
                <dd className={x.drink ? 'beo-drink' : ''}>{x.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        {plain.length > 0 && <ul className="beo-list">{plain.map((x, i) => <li key={i}>{x.value}</li>)}</ul>}
      </>
    );
  }
  if (s.kind === 'list') {
    return <ul className={`beo-list${s.key === 'dietary' ? ' beo-list-diet' : ''}`}>{s.items.map((x, i) => <li key={i}>{x.replace(BULLET, '')}</li>)}</ul>;
  }
  // text: paragraphs; a short line ending in ":" is a heading inside the section, a bulleted one is a point
  return (
    <div className="beo-text">
      {s.items.map((x, i) => {
        if (/:$/.test(x) && x.length <= 48) return <div key={i} className="beo-text-h">{x.slice(0, -1)}</div>;
        if (BULLET.test(x)) return <div key={i} className={`beo-text-pt${/^◦/.test(x) ? ' sub' : ''}`}>{x.replace(BULLET, '')}</div>;
        return <p key={i}>{x}</p>;
      })}
    </div>
  );
}

/** The import preview: which sections a BEO has ("Timeline · Menu (12) · Dietary…"). */
export function SectionChips({ found }) {
  const t = useT();
  if (!found?.length) return <div className="small muted">{t('beo.noSections')}</div>;
  return (
    <div className="beo-chips">
      <span className="small muted">{t('beo.sectionsFound')}</span>
      {found.map((s, i) => <span key={i} className={`badge${s.key === 'dietary' ? ' warn' : ''}`}>{sectionTitle(t, s)}{s.count > 1 ? ` · ${s.count}` : ''}</span>)}
    </div>
  );
}

/** What a re-import changes, section by section. */
export function SectionChanges({ changes }) {
  const t = useT();
  if (!changes?.length) return null;
  return (
    <ul className="beo-changes">
      {changes.map((c, i) => <li key={i} className={`beo-change-${c.change}`}><span className={`badge ${c.change === 'new' ? 'ok' : c.change === 'removed' ? 'bad' : 'brand'}`}>{t(`beo.change_${c.change}`)}</span>{sectionTitle(t, c)}</li>)}
    </ul>
  );
}
