// Who counts as a manager on duty (M.O.D.): one definition for the manager-on-duty card (core/training.js)
// and the printed schedule's M.O.D. block (core/schedule-pdf.js).
//
// A shift makes its person a manager on duty when the position is a manager position (its job code
// suggests the Manager role, like Manager or Chef), or the person is a manager or above working any position.
import { atLeast } from './roles.js';

/** A manager position: a job code whose suggested role is Manager. */
export const isManagerJob = (job) => job?.defaultRole === 'manager';

/** Does this shift (worked by `user` as `job`) put them on duty as a manager? */
export const isModShift = (user, job) => !!user && (isManagerJob(job) || atLeast(user, 'manager'));
