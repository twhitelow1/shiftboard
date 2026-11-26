// Reports (#/reports), managers and up: a card per report with a live number, and the report itself at
// #/reports/<path>. The list of reports is web/src/pages/reports/index.js. The server checks who may read each one
// (core/reports.js) and the plan (the `reports` feature plus each report's own).
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Empty } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import { canSeeReports } from '../../../core/reports.js';
import { availableReports } from './reports/index.js';
import '../reports.css';

export default function Reports({ parts = [] }) {
  const t = useT();
  const { me, has } = useApp();
  if (!canSeeReports(me)) return <Empty icon="report" title={t('reports.managersOnly')} />;
  const reports = availableReports(has);
  const open = reports.find((r) => r.path === parts[1]);
  if (open) return <open.Page parts={parts} />;
  return (
    <div className="rp">
      <div className="rp-head">
        <h2>{t('reports.title')}</h2>
        <div className="small muted">{t('reports.intro')}</div>
      </div>
      <div className="rp-cards">
        {reports.map((r) => <ReportCard key={r.key} report={r} />)}
      </div>
    </div>
  );
}

function ReportCard({ report }) {
  const t = useT();
  const { call, version } = useApp();
  const [head, setHead] = useState(null); // { text, tone } | { error: true }
  useEffect(() => {
    let live = true;
    report.headline?.(call, t).then((h) => { if (live) setHead(h); }, () => { if (live) setHead({ error: true }); });
    return () => { live = false; };
  }, [version, t.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <a className="card rp-card" href={`#/reports/${report.path}`}>
      <span className="rp-card-ico"><Icon name={report.icon} size={20} /></span>
      <span className="rp-card-body">
        <span className="rp-card-title">{t(report.title)}</span>
        <span className="rp-card-desc">{t(report.desc)}</span>
        {report.headline && (
          <span className={`rp-card-num ${head?.tone || ''}`} aria-live="polite">
            {!head ? '…' : head.error ? t('reports.unavailable') : head.text}
          </span>
        )}
      </span>
      <Icon name="right" size={18} />
    </a>
  );
}
