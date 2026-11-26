// When a screen crashes: a friendly "Something went wrong" (in the person's language) with Reload and Report this,
// instead of a white page. The error goes to DubLow Digital by itself (web/src/errors.js); "Report this" opens
// Report a problem with it attached. main.jsx wraps the whole app (where="app") and each page (where="page",
// so the menu stays and moving to another page clears it).
import React, { useState } from 'react';
import { reportError } from './errors.js';
import { I18nCtx, getLang, t } from './i18n/index.js';
import { Icon } from './ui.jsx';
import ReportProblem from './pages/ReportProblem.jsx';
import './report.css';

function Crash({ error, componentStack, where, reportable }) {
  const [reporting, setReporting] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <div className={`crash ${where === 'app' ? 'crash-app' : ''}`} role="alert">
      <div className="crash-card">
        <span className="crash-icon"><Icon name="alert" size={24} /></span>
        <h2>{t('crash.title')}</h2>
        <p className="muted">{sent ? t('crash.sent') : t('crash.body')}</p>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => location.reload()}>{t('crash.reload')}</button>
          {reportable && !sent && <button className="btn" onClick={() => setReporting(true)}>{t('crash.report')}</button>}
        </div>
      </div>
      {reporting && (
        <ReportProblem error={error} componentStack={componentStack}
          onClose={() => setReporting(false)} onSent={() => setSent(true)} />
      )}
    </div>
  );
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: '' };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    this.setState({ componentStack: info?.componentStack || '' });
    reportError(error, 'boundary', { componentStack: info?.componentStack });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const lang = getLang();
    // Outside the app's own language provider when the whole app crashed: give the fallback one.
    return (
      <I18nCtx.Provider value={{ lang, setLang: () => {}, choice: '' }}>
        <Crash error={this.state.error} componentStack={this.state.componentStack} where={this.props.where || 'page'} reportable={this.props.reportable !== false} />
      </I18nCtx.Provider>
    );
  }
}
