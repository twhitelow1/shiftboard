// Colors. The restaurant's Branding (Settings → Branding on the web: brand color, nav color, light background,
// appearance) drives the app the way web/src/theme.js drives the website: buttons, links and highlights in the
// brand color (lifted in dark mode), the header at the top of every screen in the nav color, and the light
// background. The rules live in ./colors.js (plain JavaScript, so tests can load them); this file types them.
import * as rules from './colors';

export const DEFAULT_BRAND: string = rules.DEFAULT_BRAND;

/** The restaurant's Branding as the app uses it. Colors are #rrggbb or '' for ShiftBoard's own. */
export interface BrandInput {
  brand?: string | null;
  nav?: string | null;
  bg?: string | null;
}
export interface Brand {
  brand: string;
  nav: string;
  bg: string;
  mode: string;
  /** The logo's path on the restaurant's server, or ''. */
  logo: string;
}

/** Mix two colors: amount of `a` (0–1), the rest `b`. */
export const mix = (a: string, b: string, amount: number): string => rules.mix(a, b, amount);

/** Black or white text, whichever reads better on `color` (same rule as core/areas.js textOn). */
export const textOn = (color?: string | null): string => rules.textOn(color);

/** A room's banner color (Settings → Rooms & positions), else a steady fallback (core/areas.js bannerColor). */
export const bannerColor = (settings: { areaColors?: Record<string, string> } | null | undefined, name: string, index = 0): string =>
  rules.bannerColor(settings, name, index);

/** Dark or light for a mode ('light' | 'dark' | 'auto' | '') and the phone's color scheme. */
export const isDark = (mode?: string | null, scheme?: string | null): boolean => rules.isDark(mode, scheme);

/** The Branding to use: the restaurant's data first, then /api/config or the copy saved with the account. */
export const brandFrom = (from: { boot?: unknown; config?: unknown; saved?: unknown; signedIn?: boolean }): Brand => rules.brandFrom(from);

export interface Palette {
  dark: boolean;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  text2: string;
  text3: string;
  brand: string;
  onBrand: string;
  brandSoft: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  bad: string;
  badSoft: string;
  /** The header at the top of every screen (the website's nav color). */
  nav: string;
  navLight: boolean;
  onNav: string;
  onNav2: string;
  navBorder: string;
  statusBar: 'light' | 'dark';
  /** <meta name="theme-color"> in the browser version (/app). */
  themeColor: string;
  /** The restaurant's mark when there's no logo, and the text on it. */
  mark: string;
  onMark: string;
  /** The sign-in screen's backdrop: a dark page with a glow of the brand color (the website's .login). */
  loginBg: string;
  loginGlow: string;
  loginGlow2: string;
}

/**
 * The app's colors. `input` is the restaurant's Branding ({ brand, nav, bg }); a plain string is just the brand
 * color, as before. Invalid colors are ignored.
 */
export function palette(dark: boolean, input?: string | null | BrandInput): Palette {
  return rules.palette(dark, input) as Palette;
}
