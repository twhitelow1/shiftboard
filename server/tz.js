// ShiftBoard works in the restaurant's wall-clock time ("today", "has this shift started",
// the iCal feed). Vercel and most containers run in UTC, and Vercel reserves the TZ
// variable, so the zone comes from TIMEZONE and is applied to the process here.
// Import this module first, before anything that reads the clock.
const DEFAULT_ZONE = 'America/Denver';

function valid(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const inherited = process.env.TZ && !/^:?UTC$/i.test(process.env.TZ) ? process.env.TZ.replace(/^:/, '') : '';
let zone = process.env.TIMEZONE || inherited || DEFAULT_ZONE;
if (!valid(zone)) {
  console.warn(`TIMEZONE "${zone}" is not a valid IANA time zone; using ${DEFAULT_ZONE}`);
  zone = DEFAULT_ZONE;
}
process.env.TZ = zone;

export const TIMEZONE = zone;
