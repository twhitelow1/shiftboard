// The consent screen's rules, as plain functions (the screen is web/src/pages/Onboarding.jsx; tests check these).
//
//   * Three separate boxes: terms (required), texts and email (optional). None is ever ticked to start with.
//   * Someone who already agreed to texts or email sees "Texts are on — change this in My Shifts" instead of
//     that box (the one-time screen at sign-in for people from before consent existed).
//   * Only a box that was shown is sent; a shown box that's unticked is sent as false (a recorded "no").
//   * Texts need a mobile number.
import { normalizePhone } from '../../core/notify-prefs.js';

/** Which boxes to show. consent: { sms, email } already given; sms: texts are available at this restaurant. */
export function consentBoxes({ consent = {}, sms = true } = {}) {
  return [
    { channel: 'terms', required: true, show: true, on: false },
    { channel: 'sms', required: false, show: sms && consent.sms !== true, on: consent.sms === true, available: sms },
    { channel: 'email', required: false, show: consent.email !== true, on: consent.email === true, available: true },
  ];
}

/** Every box starts unticked. */
export const initialChoices = () => ({ terms: false, sms: false, email: false });

/** Can the screen be sent? Terms ticked, and a valid number when texts are ticked. */
export function canSubmit(choices, phone) {
  if (choices.terms !== true) return false;
  if (choices.sms === true && !normalizePhone(phone)) return false;
  return true;
}

/** What to send: only explicit true counts; boxes that weren't shown are left out. */
export function consentPayload(boxes, choices, { phone = '', lang } = {}) {
  const shown = (c) => boxes.find((b) => b.channel === c)?.show;
  return {
    terms: choices.terms === true,
    ...(shown('sms') ? { sms: choices.sms === true } : {}),
    ...(shown('email') ? { email: choices.email === true } : {}),
    ...(shown('sms') && choices.sms === true ? { phone } : {}),
    ...(lang ? { lang } : {}),
  };
}
