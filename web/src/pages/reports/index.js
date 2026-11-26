// The reports in Reports (#/reports): one entry per card on the hub, in order. To add a report, add an entry:
//   key       unique id
//   path      its address under #/reports/ (the 86 List report is #/reports/86, its tabs #/reports/86/history…)
//   feature   the plan feature it needs on top of `reports` (server/platform/plans.js); left out, every plan has it.
//             The server checks it too: give the report's RPCs a prefix in plans.js PREFIX_FEATURES.
//   icon      an Icon name (web/src/ui.jsx)
//   title     catalog key of its name, desc: catalog key of its one-line description
//   headline  async (call, t) => ({ text, tone: 'bad' | 'warn' | 'ok' | '' }): the live number on its card
//   Page      the report itself; it gets the route's parts (['reports', path, …])
//   href      instead of Page: a report with its own address (#/impact, #/trade-stats); the card links there
// Reports run on the server, one RPC per tab, and send back small answers (see core/reports-86.js).
//
import EightySixReport from './EightySixReport.jsx';
import { headline as tradeHeadline } from './TradeStats.jsx';
import { headline as impactHeadline } from './Impact.jsx';

export const REPORTS = [
  {
    key: 'eightySix',
    path: '86',
    feature: 'eightySix',
    icon: 'ban',
    title: 'reports.e86.title',
    desc: 'reports.e86.desc',
    // eightySix.summary counts every list a manager can see, which is all of them.
    headline: async (call, t) => {
      const s = await call('eightySix.summary');
      if (!s.out && !s.low) return { text: t('reports.e86.headlineNone'), tone: 'ok' };
      return { text: t('reports.e86.headline', { out: s.out, low: s.low }), tone: s.out ? 'bad' : 'warn' };
    },
    Page: EightySixReport,
  },
  {
    key: 'impact',
    path: 'impact',
    feature: 'impact',
    icon: 'star',
    title: 'main.impact',
    desc: 'impact.cardDesc',
    headline: async (call, t) => ({ text: (await impactHeadline({ call, t })) || t('reports.e86.headlineNone').slice(0, 0), tone: '' }),
    href: '#/impact',
  },
  {
    key: 'tradeStats',
    path: 'trades',
    icon: 'chart',
    title: 'tradeStats.title',
    desc: 'tradeStats.subtitle',
    headline: async (call, t) => ({ text: await tradeHeadline({ call, t }), tone: '' }),
    href: '#/trade-stats',
  },
];

/** The reports this restaurant's plan includes. has(feature) comes from the app's context. */
export const availableReports = (has) => REPORTS.filter((r) => !r.feature || !has || has(r.feature));
