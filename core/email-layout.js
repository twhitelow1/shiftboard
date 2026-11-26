// The look of a notification email (the same as server/email.js's layout), for emails made from a restaurant's
// templates (core/email-templates.js). Pure, so Settings → Email notifications previews exactly what is sent.
// Everything is escaped: templates are text a restaurant wrote, never HTML.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} o
 * @param {string} o.restaurant
 * @param {Array<{kind: 'p', lines: string[]} | {kind: 'button', label: string, url: string}>} o.blocks
 * @param {string} o.footer
 * @param {object} [o.brand]  { color, logoUrl } from Settings → Branding
 * @param {string} [o.lang]
 * @returns {{ html: string, text: string }}
 */
export function emailLayout({ restaurant, blocks, footer, brand = {}, lang = 'en' }) {
  const color = /^#[0-9a-f]{6}$/i.test(brand.color || '') ? brand.color : null;
  const head = color || '#0f172a';
  const buttonColor = color || '#4f46e5';
  const logo = /^https:\/\//.test(brand.logoUrl || '') ? `<img src="${esc(brand.logoUrl)}" alt="" height="32" style="height:32px;max-width:160px;vertical-align:middle;margin-right:10px;border-radius:4px;background:#fff">` : '';
  const body = blocks.map((b) => (b.kind === 'button'
    ? `<p style="margin:22px 0 6px"><a href="${esc(b.url)}" style="display:inline-block;background:${buttonColor};color:#ffffff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px">${esc(b.label)}</a></p>`
    : `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${b.lines.map(esc).join('<br>')}</p>`)).join('\n');
  const html = `<!doctype html><html${lang === 'en' ? '' : ` lang="${esc(lang)}"`}><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${head};color:#ffffff;padding:16px 24px;font-weight:700;font-size:16px">${logo}${esc(restaurant)} · ShiftBoard</td></tr>
<tr><td style="padding:24px">

${body}
</td></tr>
<tr><td style="padding:14px 24px 20px;color:#64748b;font-size:12px;line-height:1.5;border-top:1px solid #e2e8f0">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [...blocks.map((b) => (b.kind === 'button' ? `${b.label}: ${b.url}` : b.lines.join('\n'))), '', footer].join('\n\n').trim();
  return { html, text };
}
