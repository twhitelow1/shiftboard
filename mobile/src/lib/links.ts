// Where a notification goes in the app. Notifications carry the website's links ('#/swaps', '#/86',
// '#/events/evt_1', '#/training/manual/mpg_2', '#/tips/2026-09-28'…); each opens the matching screen here.
// Links to screens the app doesn't have (or features the restaurant's plan doesn't include) open the
// notifications list.
import type { Href } from 'expo-router';

import type { Feature } from './features';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The screen for a link. has(feature) says whether the restaurant's plan includes a feature. */
export function routeForLink(link: string | undefined, has: (f: Feature) => boolean = () => true): Href {
  const raw = String(link || '').replace(/^#?\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const q = new URLSearchParams(query);
  const [head, a, b] = parts;
  switch (head) {
    case 'my':
    case 'calendar':
      // '#/my' (the schedule changed); '#/my/<shiftId>' or '?shift=<id>' opens that shift.
      if (a || q.get('shift')) return { pathname: '/shift/[id]', params: { id: a || q.get('shift')!, ...(q.get('date') ? { date: q.get('date')! } : {}) } };
      return '/shifts';
    case 'shift':
    case 'shifts':
      return a ? { pathname: '/shift/[id]', params: { id: a, ...(q.get('date') ? { date: q.get('date')! } : {}) } } : '/shifts';
    case 'schedule':
      return a && DATE.test(a) ? { pathname: '/schedule', params: { date: a } } : '/schedule';
    case 'swaps':
      return '/swaps';
    case 'timeoff':
      // Time Off is a tab only without Training (src/navigation.ts timeOffRoute).
      return a === 'availability' ? '/availability' : has('training') ? '/my-time-off' : '/time-off';
    case '86':
      if (!has('eightySix')) break;
      return a ? { pathname: '/eighty-six', params: { item: a } } : '/eighty-six';
    case 'events':
      if (!has('events')) break;
      return a ? { pathname: '/events/[id]', params: { id: a } } : '/events';
    case 'training':
      if (!has('training')) break;
      if (a === 'quiz' && b) return { pathname: '/quiz/[id]', params: { id: b } };
      if (a === 'manual' && b) return { pathname: '/manual/[id]', params: { id: b } };
      if (a === 'menu' && b) return { pathname: '/menu/[id]', params: { id: b } };
      if (a === 'study') return '/study';
      return { pathname: '/training', params: { tab: ({ quizzes: 'quizzes', board: 'board', manual: 'manual' } as Record<string, string>)[a || ''] || 'menu' } };
    case 'tips':
      if (!has('tips')) break;
      return a && DATE.test(a) ? { pathname: '/tips', params: { week: a } } : '/tips';
    default:
      break;
  }
  return '/notifications';
}
