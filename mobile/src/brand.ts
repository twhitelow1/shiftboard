// The app's name and invite-link scheme, from mobile/brand.js (the one place to rename the app).
import BRAND from '../brand';

/** The name people see ("ShiftBoard" for now). The app's words say {app}; translate() fills it in. */
export const APP_NAME: string = BRAND.name;
/** Invite links: <scheme>://join?server=… */
export const APP_SCHEME: string = BRAND.scheme;
/** Schemes an invite link may use: the current one and older ones from before a rename. */
export const LINK_SCHEMES: string[] = [...new Set([BRAND.scheme, ...(BRAND.oldSchemes || [])])];
