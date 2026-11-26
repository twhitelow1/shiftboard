// Reports (#/reports): a section for managers and up, one card per report (web/src/pages/reports/index.js).
// The restaurant's plan has to include the `reports` feature (server/platform/plans.js), and each report its own
// feature too (the 86 List report: `eightySix`). Who may open them is decided here, in one place, so the role
// editor can take it over (a `reports` role feature) without touching each report.
import { atLeast } from './roles.js';

/** May this person open Reports? Managers and up; supervisors and employees can't. */
export const canSeeReports = (u) => atLeast(u, 'manager');
