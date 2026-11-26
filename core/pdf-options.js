// The printed schedule's options (core/schedule-pdf.js), kept apart from the PDF code so the app can check
// them without loading the PDF library.

/** Paper sizes in points (portrait): Letter, Legal, Tabloid (11×17). */
export const PAPER = { letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224] };

/** Clean PDF options from a request: { paper, orientation, fit, rooms, lang }. */
export function cleanPdfOptions(o = {}) {
  const rooms = (Array.isArray(o.rooms) ? o.rooms : String(o.rooms || '').split(','))
    .map((r) => String(r || '').trim()).filter(Boolean).slice(0, 30);
  return {
    paper: Object.hasOwn(PAPER, o.paper) ? o.paper : 'letter',
    orientation: o.orientation === 'landscape' ? 'landscape' : 'portrait',
    fit: o.fit === 'split' ? 'split' : 'fit',
    rooms,
    lang: o.lang === 'es' || o.lang === 'en' ? o.lang : null,
  };
}
