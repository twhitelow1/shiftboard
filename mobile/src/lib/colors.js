// The restaurant's look in the app, as plain JavaScript so the tests (test/mobile-theme.test.js) can load it
// without a TypeScript step. src/lib/theme.ts gives it types; screens use that.
//
// It mirrors the website: web/src/theme.js applyBranding (Settings → Branding) and the colors in
// web/src/styles.css. Keep the two in step.
//
//   website            app (Palette)
//   --brand            brand (lifted in dark mode), brandSoft; onBrand = readable text on it
//   --bg               bg, and surface2 derived from it (light mode only; dark mode keeps its own,
//                      tinted by the brand color)
//   --nav              nav: the header at the top of every screen (the website's sidebar, and the
//                      browser bar on a phone via <meta name="theme-color">); onNav/onNav2 = its text.
//                      A light nav color stays dark in dark mode, like the website's sidebar.
//   theme-color        themeColor (the browser version at /app sets the same <meta>)
//   .login             loginBg + loginGlow (+ loginGlow2 without a brand color): the sign-in screen
//
// Room banners: bannerColor and textOn are copied from core/areas.js (the app can't import ../core).
'use strict';

const DEFAULT_BRAND = '#4f46e5';

/** A #rrggbb color in lowercase, or '' for anything else. */
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? String(c).toLowerCase() : '');

const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * Mix two colors like CSS color-mix(in srgb, a <amount>, b): amount of `a` (0–1), the rest `b`.
 * @param {string} a @param {string} b @param {number} amount @returns {string}
 */
function mix(a, b, amount) {
  const x = rgb(a), y = rgb(b);
  return toHex(x.map((v, i) => v * amount + y[i] * (1 - amount)));
}

/** Relative luminance (WCAG) of a #rrggbb color. */
function luminance(h) {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Black or white text, whichever reads better on `color` (the rule of core/areas.js textOn: black unless the
 * fill is dark). Anything that isn't a color gets black, like there.
 * @param {string | null | undefined} color @returns {string}
 */
function textOn(color) {
  const h = hex(color);
  if (!h) return '#000000';
  return luminance(h) > 0.15 ? '#000000' : '#ffffff';
}

// Banner colors for rooms that don't have one yet (core/areas.js FALLBACK_COLORS).
const FALLBACK_COLORS = ['#9bc2e6', '#a9d08e', '#f4b084', '#ffd966', '#b4c6e7', '#c9c9c9', '#f8cbad', '#c6e0b4'];
const areaKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The banner color for a room or department: its color from Settings → Rooms & positions (settings.areaColors),
 * else a steady fallback by its place in the list. Same as core/areas.js bannerColor.
 * @param {{ areaColors?: Record<string, string> } | null | undefined} settings
 * @param {string} name @param {number} [index] @returns {string}
 */
function bannerColor(settings, name, index) {
  const colors = (settings && settings.areaColors) || {};
  const k = areaKey(name);
  const hit = k ? Object.keys(colors).find((x) => areaKey(x) === k) : undefined;
  return hit ? colors[hit] : FALLBACK_COLORS[Math.abs(index || 0) % FALLBACK_COLORS.length];
}

/**
 * The app's colors, like the website's for the same settings.
 * `input` is the restaurant's Branding: { brand, nav, bg } (#rrggbb, anything else is ignored), or, as before,
 * just the brand color. `dark` is the mode in use (see isDark).
 * @param {boolean} dark
 * @param {string | null | undefined | { brand?: string | null, nav?: string | null, bg?: string | null }} [input]
 */
function palette(dark, input) {
  const o = input && typeof input === 'object' ? input : { brand: input };
  const c = hex(o.brand), n = hex(o.nav), b = hex(o.bg);

  let base;
  if (dark) {
    base = {
      // Dark mode keeps its own background; a brand color lifts to stay readable and tints the background.
      bg: c ? mix(c, '#0b1020', 0.06) : '#0b1020',
      surface: c ? mix(c, '#121a2e', 0.05) : '#121a2e',
      surface2: c ? mix(c, '#1a2440', 0.07) : '#1a2440', // the website's --surface-3 (raised fills)
      border: '#22304f',
      text: '#e6ebf5', text2: '#aab5cb', text3: '#7d8aa6',
      brand: c ? mix(c, '#ffffff', 0.7) : '#818cf8',
      brandSoft: c ? mix(c, '#0b1020', 0.28) : '#1e2350',
      ok: '#4ade80', okSoft: '#12301f', warn: '#fbbf24', warnSoft: '#3a2a0a', bad: '#f87171', badSoft: '#3b1418',
    };
  } else {
    base = {
      bg: b || '#f4f5f7',
      surface: '#ffffff',
      surface2: b ? mix(b, '#ffffff', 0.6) : '#f8fafc',
      border: '#e2e8f0',
      text: '#0f172a', text2: '#475569', text3: '#64748b',
      brand: c || DEFAULT_BRAND,
      brandSoft: c ? mix(c, '#ffffff', 0.12) : '#eef0ff',
      ok: '#15803d', okSoft: '#dcfce7', warn: '#b45309', warnSoft: '#fef3c7', bad: '#b91c1c', badSoft: '#fee2e2',
    };
  }

  // The nav color (the website's --nav). In dark mode only a dark nav color is kept; a light one gives way to
  // the dark default so the header doesn't glare (web/src/theme.js: "in dark mode the sidebar stays dark").
  const nav = dark ? (n && textOn(n) === '#ffffff' ? n : '#070b16') : n || '#0f172a';
  const navLight = textOn(nav) === '#000000';

  return {
    dark,
    ...base,
    onBrand: textOn(base.brand),
    nav,
    navLight,
    /** Titles and icons on the nav color (the website's .brand / .sidebar-user). */
    onNav: navLight ? '#0f172a' : '#ffffff',
    /** Quieter text on the nav color (the website's --nav-text). */
    onNav2: navLight ? '#334155' : '#cbd5e1',
    navBorder: navLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)',
    /** The phone's status bar sits on the nav color: light icons on a dark nav, dark ones on a light nav. */
    statusBar: navLight ? 'dark' : 'light',
    /** <meta name="theme-color">: the nav color as set, like the website (not changed by dark mode). */
    themeColor: n || '#0f172a',
    /** The restaurant's mark when there's no logo: its color as set (the website's .brand-mark). */
    mark: c || DEFAULT_BRAND,
    onMark: textOn(c || DEFAULT_BRAND),
    /** The sign-in screen's backdrop (the website's .login): dark, with a glow of the brand color. */
    loginBg: '#0b1020',
    loginGlow: c ? mix(c, '#000000', 0.55) : '#312e81',
    loginGlow2: c ? '' : '#0e7490',
  };
}

/**
 * Dark or light: a person's own choice (More → Appearance), else the restaurant's, else the phone's.
 * @param {string | null | undefined} mode 'light' | 'dark' | 'auto' | ''
 * @param {string | null | undefined} scheme the phone's color scheme
 */
function isDark(mode, scheme) {
  return mode === 'dark' || (mode !== 'light' && scheme === 'dark');
}

const logoPath = (version) => (version ? `/api/branding/logo?v=${version}` : '');

/**
 * Where the colors come from, freshest first, so a change in Settings → Branding shows on the next refresh:
 *   1. the restaurant's data (app.bootstrap settings, and the person's own appearance), loaded at every start
 *      and every time the app comes back to the front;
 *   2. before that, /api/config (fetched at the same times), or the copy saved with the account last time:
 *      signed in, the saved copy goes first (it has the person's own appearance; the bootstrap replaces it in
 *      a moment); signed out, /api/config goes first (what the sign-in page shows).
 * Empty values mean "ShiftBoard's own": a color an admin removes goes away, instead of an older one staying.
 * @param {{ boot?: any, config?: any, saved?: any, signedIn?: boolean }} from
 * @returns {{ brand: string, nav: string, bg: string, mode: string, logo: string }}
 */
function brandFrom({ boot, config, saved, signedIn } = {}) {
  if (boot && boot.settings) {
    const st = boot.settings;
    return {
      brand: hex(st.brandColor), nav: hex(st.navColor), bg: hex(st.bgColor),
      mode: (boot.me && boot.me.appearance) || st.appearance || 'auto',
      logo: logoPath(st.logoVersion),
    };
  }
  const cb = config && config.brand;
  const fromConfig = cb ? { brand: hex(cb.color), nav: hex(cb.nav), bg: hex(cb.bg), mode: cb.mode || 'auto', logo: cb.logo || '' } : null;
  const fromSaved = saved && typeof saved === 'object'
    ? { brand: hex(saved.brand), nav: hex(saved.nav), bg: hex(saved.bg), mode: saved.mode || 'auto', logo: saved.logo || '' } : null;
  return (signedIn ? fromSaved || fromConfig : fromConfig || fromSaved) || { brand: '', nav: '', bg: '', mode: 'auto', logo: '' };
}

module.exports = { DEFAULT_BRAND, FALLBACK_COLORS, hex, mix, textOn, bannerColor, palette, isDark, brandFrom };
