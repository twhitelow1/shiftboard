// The restaurant's look (Settings → Branding): its color on buttons, links and highlights, its
// sidebar color, and its logo in the browser tab. Written as one <style> so light and dark mode
// both get a readable version of the color.
import { textOn } from '../../core/areas.js';

const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : '');

export function applyBranding({ color, nav, logo } = {}) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('sb-brand');
  if (!el) {
    el = document.createElement('style');
    el.id = 'sb-brand';
    document.head.appendChild(el);
  }
  const c = hex(color), n = hex(nav);
  let css = '';
  if (c) {
    css += `:root{--brand:${c};--brand-2:color-mix(in srgb,${c} 82%,#000);--brand-soft:color-mix(in srgb,${c} 12%,#fff);}`;
    const dark = `--brand:color-mix(in srgb,${c} 70%,#fff);--brand-2:${c};--brand-soft:color-mix(in srgb,${c} 28%,#0b1020);`;
    css += `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`;
    css += `.brand-mark{background:${c};color:${textOn(c)};}.nav-item.active{background:color-mix(in srgb,${c} 30%,transparent);}`;
    css += `.login{background:radial-gradient(1200px 600px at 20% -10%,color-mix(in srgb,${c} 55%,#000) 0,transparent 60%),#0b1020;}`;
  }
  if (n) {
    css += `:root{--nav:${n};}`;
    if (textOn(n) === '#000') { // a light sidebar needs dark text
      css += '.sidebar{--nav-text:#334155;}.sidebar .brand{color:#0f172a;}.sidebar .brand-sub,.sidebar .nav-section{color:#64748b;}'
        + '.sidebar-user{color:#0f172a;}.nav-item:hover,.nav-item.active{color:#0f172a;}.nav-item:hover{background:rgba(0,0,0,.06);}.sidebar-foot{border-top-color:rgba(0,0,0,.1);}';
    }
  }
  el.textContent = css;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', n || '#0f172a');
  let icon = document.querySelector('link[rel="icon"]');
  if (logo) {
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
    icon.href = logo;
  } else if (icon && icon.dataset.brand) icon.remove();
  if (icon && logo) icon.dataset.brand = '1';
}

/** The logo's URL for a settings object, or '' when there's none (the demo has no server to serve one). */
export const logoUrl = (settings, isDemo = false) => (!isDemo && settings?.logoVersion ? `/api/branding/logo?v=${settings.logoVersion}` : '');

/**
 * Make an uploaded image a small PNG data URL (max 512px on the long side, transparency kept):
 * logos stay light, and any format the browser can show (SVG too) becomes a safe PNG.
 */
export function imageToPng(file, max = 512) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max));
      const w = Math.max(1, Math.round((img.naturalWidth || max) * scale)), h = Math.max(1, Math.round((img.naturalHeight || max) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let out = canvas.toDataURL('image/png');
      if (out.length > 500000) out = canvas.toDataURL('image/webp', 0.9);
      resolve({ dataUrl: out, color: mainColor(canvas) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t an image the browser can read')); };
    img.src = url;
  });
}

/** The logo's strongest color (ignoring near-white, near-black, grey and see-through pixels), or ''. */
function mainColor(canvas) {
  try {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const bins = new Map();
    for (let i = 0; i < data.length; i += 16) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (a < 200 || mx < 40 || mn > 225 || mx - mn < 40) continue;
      const k = `${r >> 4},${g >> 4},${b >> 4}`;
      const v = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      v.n++; v.r += r; v.g += g; v.b += b;
      bins.set(k, v);
    }
    const best = [...bins.values()].sort((x, y) => y.n - x.n)[0];
    if (!best) return '';
    return `#${[best.r, best.g, best.b].map((t) => Math.round(t / best.n).toString(16).padStart(2, '0')).join('')}`;
  } catch { return ''; }
}
