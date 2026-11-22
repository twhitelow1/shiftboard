// Money the way the server writes it (core/tips.js fmtCents): $1,234.50 from integer cents. The tip pool's
// explanations come from the server in this format, so the app's own amounts match them.
export function fmtCents(c: number): string {
  const n = Math.round(Number(c) || 0);
  const a = Math.abs(n);
  return `${n < 0 ? '−' : ''}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}
