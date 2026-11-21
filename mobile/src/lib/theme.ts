// Colors. The restaurant's brand color (Settings → Branding on the web, sent by /api/config as
// brand.color) drives buttons, links and highlights, like web/src/theme.js does for the website.
// In dark mode the brand color is lifted so it stays readable.

export const DEFAULT_BRAND = '#4f46e5';

const hex = (c?: string | null) => (/^#[0-9a-f]{6}$/i.test(c || '') ? (c as string).toLowerCase() : '');

function rgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** Mix two colors: amount of `a` (0–1), the rest `b`. */
export function mix(a: string, b: string, amount: number): string {
  const x = rgb(a), y = rgb(b);
  return toHex(x.map((v, i) => v * amount + y[i] * (1 - amount)));
}

/** Black or white text, whichever reads better on `color` (same rule as core/areas.js textOn). */
export function textOn(color: string): string {
  const h = hex(color);
  if (!h) return '#000000';
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.15 ? '#000000' : '#ffffff';
}

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
}

export function palette(dark: boolean, brandColor?: string | null): Palette {
  const base = hex(brandColor) || DEFAULT_BRAND;
  if (dark) {
    const brand = mix(base, '#ffffff', 0.7);
    return {
      dark, bg: mix(base, '#0b1020', 0.06), surface: mix(base, '#121a2e', 0.05), surface2: mix(base, '#1a2440', 0.07), border: '#22304f',
      text: '#e6ebf5', text2: '#aab5cb', text3: '#7d8aa6', brand, onBrand: textOn(brand), brandSoft: mix(base, '#0b1020', 0.28),
      ok: '#4ade80', okSoft: '#12301f', warn: '#fbbf24', warnSoft: '#3a2a0a', bad: '#f87171', badSoft: '#3b1418',
    };
  }
  return {
    dark, bg: '#f4f5f7', surface: '#ffffff', surface2: '#f8fafc', border: '#e2e8f0',
    text: '#0f172a', text2: '#475569', text3: '#64748b', brand: base, onBrand: textOn(base), brandSoft: mix(base, '#ffffff', 0.12),
    ok: '#15803d', okSoft: '#dcfce7', warn: '#b45309', warnSoft: '#fef3c7', bad: '#b91c1c', badSoft: '#fee2e2',
  };
}
