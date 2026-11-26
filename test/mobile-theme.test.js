// The phone app's colors follow Settings → Branding the way the website does (web/src/theme.js): brand color,
// nav color (the app's header), light background, appearance; and room banners in the room's color
// (core/areas.js). The rules are in mobile/src/lib/colors.js, plain JavaScript so they load here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bannerColor as coreBanner, textOn as coreTextOn } from '../core/areas.js';

const require = createRequire(import.meta.url);
const { palette, textOn, bannerColor, isDark, brandFrom, mix, FALLBACK_COLORS } = require('../mobile/src/lib/colors.js');

const BRAND = { brand: '#7c2d91', nav: '#1f0a2b', bg: '#f7f3fa' }; // the website's "Berry" theme

test('light mode: brand color as set, background and its lighter fill from the background color', () => {
  const p = palette(false, BRAND);
  assert.equal(p.dark, false);
  assert.equal(p.brand, '#7c2d91');
  assert.equal(p.onBrand, '#ffffff');
  assert.equal(p.brandSoft, mix('#7c2d91', '#ffffff', 0.12)); // --brand-soft: color-mix(c 12%, #fff)
  assert.equal(p.bg, '#f7f3fa');
  assert.equal(p.surface2, mix('#f7f3fa', '#ffffff', 0.6)); // --surface-2: color-mix(bg 60%, #fff)
  assert.equal(p.surface, '#ffffff'); // cards stay white, like the website's --surface
});

test('dark mode: brand lifted, background stays dark with a hint of the brand, the bg color is ignored', () => {
  const p = palette(true, BRAND);
  assert.equal(p.dark, true);
  assert.equal(p.brand, mix('#7c2d91', '#ffffff', 0.7)); // --brand: color-mix(c 70%, #fff)
  assert.equal(p.brandSoft, mix('#7c2d91', '#0b1020', 0.28));
  assert.equal(p.bg, mix('#7c2d91', '#0b1020', 0.06)); // not #f7f3fa
  assert.equal(p.surface, mix('#7c2d91', '#121a2e', 0.05));
  assert.notEqual(p.bg, BRAND.bg);
  assert.equal(palette(true, { bg: '#f7f3fa' }).bg, '#0b1020'); // bg alone: dark mode untouched
});

test('without Branding: ShiftBoard\'s own colors, the website\'s defaults', () => {
  const light = palette(false), dark = palette(true);
  assert.equal(light.brand, '#4f46e5');
  assert.equal(light.bg, '#f4f5f7');
  assert.equal(light.nav, '#0f172a');
  assert.equal(dark.brand, '#818cf8');
  assert.equal(dark.bg, '#0b1020');
  assert.equal(dark.nav, '#070b16');
  assert.equal(light.themeColor, '#0f172a');
  assert.deepEqual(palette(false, {}), light);
});

test('a dark nav color: the header in that color with light text, in light and dark mode', () => {
  for (const dark of [false, true]) {
    const p = palette(dark, BRAND);
    assert.equal(p.nav, '#1f0a2b');
    assert.equal(p.navLight, false);
    assert.equal(p.onNav, '#ffffff');
    assert.equal(p.onNav2, '#cbd5e1'); // --nav-text
    assert.equal(p.statusBar, 'light');
    assert.equal(p.themeColor, '#1f0a2b');
  }
});

test('a light nav color: dark text on it in light mode; dark mode keeps a dark header instead', () => {
  const light = palette(false, { brand: '#4f46e5', nav: '#ffffff' }); // the "Bright" theme
  assert.equal(light.nav, '#ffffff');
  assert.equal(light.navLight, true);
  assert.equal(light.onNav, '#0f172a');
  assert.equal(light.onNav2, '#334155');
  assert.equal(light.statusBar, 'dark');
  const dark = palette(true, { brand: '#4f46e5', nav: '#ffffff' });
  assert.equal(dark.nav, '#070b16');
  assert.equal(dark.navLight, false);
  assert.equal(dark.onNav, '#ffffff');
  assert.equal(dark.statusBar, 'light');
  assert.equal(dark.themeColor, '#ffffff'); // <meta name="theme-color"> is the nav color as set, like the website
});

test('invalid colors are ignored', () => {
  for (const bad of ['red', '#abc', '#12345g', 'rgb(1,2,3)', '', null, undefined, 42, '#1234567']) {
    assert.deepEqual(palette(false, { brand: bad, nav: bad, bg: bad }), palette(false), String(bad));
    assert.deepEqual(palette(true, { brand: bad, nav: bad, bg: bad }), palette(true), String(bad));
  }
  assert.equal(palette(false, { brand: '#7C2D91' }).brand, '#7c2d91'); // upper case is fine
});

test('a plain string is still just the brand color (the old signature)', () => {
  assert.deepEqual(palette(false, '#7c2d91'), palette(false, { brand: '#7c2d91' }));
  assert.deepEqual(palette(true, '#7c2d91'), palette(true, { brand: '#7c2d91' }));
  assert.deepEqual(palette(true, null), palette(true));
});

test('readable text on every surface it sets', () => {
  for (const c of ['#000000', '#ffffff', '#7c2d91', '#ffd966', '#0e7490', '#fbbf24']) {
    assert.equal(textOn(c), coreTextOn(c) === '#000' ? '#000000' : '#ffffff', c);
    const p = palette(false, { brand: c, nav: c });
    assert.equal(p.onBrand, textOn(p.brand));
    assert.equal(p.onNav === '#0f172a', textOn(p.nav) === '#000000');
  }
  assert.equal(textOn('nope'), '#000000');
});

test('the sign-in backdrop takes the brand color, like the website\'s .login', () => {
  assert.equal(palette(false, BRAND).loginGlow, mix('#7c2d91', '#000000', 0.55));
  assert.equal(palette(false, BRAND).loginGlow2, '');
  assert.equal(palette(false).loginGlow, '#312e81');
  assert.equal(palette(false).loginGlow2, '#0e7490');
  assert.equal(palette(true, BRAND).loginBg, '#0b1020');
});

test('appearance: the person\'s choice, else the restaurant\'s, else the phone', () => {
  assert.equal(isDark('dark', 'light'), true);
  assert.equal(isDark('light', 'dark'), false);
  assert.equal(isDark('auto', 'dark'), true);
  assert.equal(isDark('', 'light'), false);
  const boot = (me, st) => ({ me: { appearance: me }, settings: { appearance: st } });
  assert.equal(brandFrom({ boot: boot('dark', 'light') }).mode, 'dark');
  assert.equal(brandFrom({ boot: boot('', 'light') }).mode, 'light');
  assert.equal(brandFrom({ boot: boot('', undefined) }).mode, 'auto');
});

test('the restaurant\'s data wins over /api/config and the saved copy, so a change shows on the next refresh', () => {
  const config = { brand: { name: 'X', color: '#111111', nav: '#222222', bg: '#eeeeee', mode: 'dark', logo: '/api/branding/logo?v=1' } };
  const saved = { brand: '#333333', nav: '#444444', bg: '#dddddd', mode: 'light', logo: '/api/branding/logo?v=0' };
  const boot = { me: { appearance: '' }, settings: { brandColor: '#7c2d91', navColor: '#1f0a2b', bgColor: '', appearance: 'auto', logoVersion: 2 } };
  assert.deepEqual(brandFrom({ boot, config, saved, signedIn: true }), { brand: '#7c2d91', nav: '#1f0a2b', bg: '', mode: 'auto', logo: '/api/branding/logo?v=2' });
  // A color the admin removed (bgColor '') stays removed: the older config's #eeeeee doesn't come back.
  assert.equal(brandFrom({ boot, config }).bg, '');
  // Before the data: signed out, the sign-in page's Branding; signed in, the copy saved last time.
  assert.equal(brandFrom({ config, saved, signedIn: false }).brand, '#111111');
  assert.equal(brandFrom({ config, saved, signedIn: true }).brand, '#333333');
  assert.equal(brandFrom({ config, signedIn: true }).nav, '#222222');
  assert.deepEqual(brandFrom({}), { brand: '', nav: '', bg: '', mode: 'auto', logo: '' });
  assert.equal(brandFrom({ boot: { me: {}, settings: { brandColor: 'purple' } } }).brand, ''); // invalid: ignored
});

test('room banners: the room\'s color from Settings → Rooms & positions, the same as core/areas.js', () => {
  const settings = { areaColors: { 'Moon Rabbit': '#ff0000', 'RABBIT HOLE': '#1f4e78' } };
  for (const [name, i] of [['Moon Rabbit', 0], ['moon rabbit', 3], ['Rabbit Hole', 1], ['Restaurant', 2], ['Patio', 9], ['', 0], ['Bar', -3]]) {
    assert.equal(bannerColor(settings, name, i), coreBanner(settings, name, i), name);
  }
  assert.equal(bannerColor(settings, 'Rabbit Hole', 5), '#1f4e78');
  assert.equal(textOn(bannerColor(settings, 'Rabbit Hole', 5)), '#ffffff'); // dark fill: white text
  assert.equal(textOn(bannerColor({}, 'Restaurant', 0)), '#000000'); // light fallback fill: black text
  assert.equal(bannerColor(undefined, 'Restaurant', 1), FALLBACK_COLORS[1]);
});
