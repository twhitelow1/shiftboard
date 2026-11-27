// Invented Excel workbooks for tests: several sheets, cell fills (RGB, or a theme colour with a tint, like Excel writes
// them), real Excel dates and times, merged cells. Nothing here comes from a real restaurant's file.
import { zipSync, strToU8 } from 'fflate';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
/** 'YYYY-MM-DD' → an Excel serial date. */
export const serial = (date) => Date.parse(`${date}T00:00:00Z`) / 864e5 + 25569;

/**
 * sheets: [{ name, rows: [[cell]], merges?: ['C13:C17'] }]. A cell: a string, or { text?, date?, time? ('HH:MM'),
 * fill?: { rgb: 'FFFF00' } | { theme: 9, tint: 0.4 } }. theme: the accent colours (theme1.xml), Office's newer ones by default.
 */
export function makeXlsx(sheets, { accents = ['156082', 'E97132', '196B24', '0F9ED5', 'A02B93', '4EA72E'] } = {}) {
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const fillIds = new Map();
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'];
  const xfIds = new Map();
  const fillOf = (f) => {
    if (!f) return 0;
    const key = JSON.stringify(f);
    if (!fillIds.has(key)) {
      const color = f.rgb ? `rgb="FF${f.rgb}"` : `theme="${f.theme}"${f.tint ? ` tint="${f.tint}"` : ''}`;
      fills.push(`<fill><patternFill patternType="solid"><fgColor ${color}/><bgColor indexed="64"/></patternFill></fill>`);
      fillIds.set(key, fills.length - 1);
    }
    return fillIds.get(key);
  };
  const styleOf = (fill, numFmt) => {
    const key = `${fillOf(fill)}|${numFmt}`;
    if (!xfIds.has(key)) { xfs.push(`<xf numFmtId="${numFmt}" fontId="0" fillId="${fillOf(fill)}" borderId="0" applyFill="1"${numFmt ? ' applyNumberFormat="1"' : ''}/>`); xfIds.set(key, xfs.length - 1); }
    return xfIds.get(key);
  };
  const strings = [];
  const sIndex = new Map();
  const str = (t) => { if (!sIndex.has(t)) { sIndex.set(t, strings.length); strings.push(t); } return sIndex.get(t); };
  const files = {};
  sheets.forEach((sh, si) => {
    const rows = sh.rows.map((r, ri) => {
      const cells = (r || []).map((c, ci) => {
        if (c == null || c === '') return '';
        const cell = typeof c === 'string' ? { text: c } : c;
        const ref = `${colName(ci)}${ri + 1}`;
        if (cell.date) return `<c r="${ref}" s="${styleOf(cell.fill, 14)}"><v>${serial(cell.date)}</v></c>`;
        if (cell.time) { const [h, m] = cell.time.split(':').map(Number); return `<c r="${ref}" s="${styleOf(cell.fill, 20)}"><v>${(h * 60 + m) / 1440}</v></c>`; }
        const s = styleOf(cell.fill, 0);
        return cell.text ? `<c r="${ref}" s="${s}" t="s"><v>${str(cell.text)}</v></c>` : `<c r="${ref}" s="${s}"/>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges}</worksheet>`);
  });
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships>${sheets.map((sh, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0"?><sst>${strings.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`);
  files['xl/styles.xml'] = strToU8(`<?xml version="1.0"?><styleSheet><fills count="${fills.length}">${fills.join('')}</fills><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs></styleSheet>`);
  const scheme = ['dk1:000000', 'lt1:FFFFFF', 'dk2:0E2841', 'lt2:E8E8E8', ...accents.map((a, i) => `accent${i + 1}:${a}`), 'hlink:467886', 'folHlink:96607D']
    .map((x) => { const [k, v] = x.split(':'); return `<a:${k}><a:srgbClr val="${v}"/></a:${k}>`; }).join('');
  files['xl/theme/theme1.xml'] = strToU8(`<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Test">${scheme}</a:clrScheme></a:themeElements></a:theme>`);
  return zipSync(files);
}
