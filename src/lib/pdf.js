'use strict';
/**
 * A table as a PDF, with no dependencies.
 *
 * Uses the PDF standard fonts (Helvetica), which every reader has built in,
 * so nothing is embedded and nothing needs bundling into the function. That
 * matters on Netlify: font-loading PDF libraries read files from disk at
 * runtime and break once esbuild has packed them.
 *
 * Enough for what accounting needs — a titled, paginated table with totals.
 */

const PAGE_W = 792, PAGE_H = 612;          // US Letter, landscape
const MARGIN = 40;
const ROW_H = 16;
const SIZE = 8.5;

/** WinAnsi covers Latin-1; anything else becomes "?" rather than garbage. */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}
const pdfStr = s => '(' + clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';

// Helvetica averages a little over half the font size per character. Close
// enough to truncate long descriptions and right-align numbers.
const textWidth = (s, size) => clean(s).length * size * 0.52;
function fit(s, width, size) {
  const str = clean(s);
  const max = Math.floor(width / (size * 0.52));
  return str.length <= max ? str : str.slice(0, Math.max(0, max - 3)) + '...';
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.subtitle]
 * @param {{label:string, width:number, align?:'right'}[]} o.columns  widths are fractions of the table
 * @param {Array<Array<string|number>>} o.rows
 * @param {Array<string|number>} [o.footer]  a totals row, drawn bold after the last row
 * @param {string} [o.note]
 * @returns {Buffer}
 */
function tablePDF({ title, subtitle = '', columns, rows, footer, note }) {
  const tableW = PAGE_W - MARGIN * 2;
  const total = columns.reduce((s, c) => s + c.width, 0);
  let x = MARGIN;
  const cols = columns.map(c => {
    const w = (c.width / total) * tableW;
    const col = { ...c, x, w };
    x += w;
    return col;
  });

  const cell = (text, col, y, font) => {
    const t = fit(text, col.w - 8, SIZE);
    const tx = col.align === 'right' ? col.x + col.w - 4 - textWidth(t, SIZE) : col.x + 4;
    return `BT /${font} ${SIZE} Tf ${tx.toFixed(2)} ${y.toFixed(2)} Td ${pdfStr(t)} Tj ET\n`;
  };
  const rule = (y, weight, grey) =>
    `${grey} G ${weight} w ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S\n`;

  const pages = [];
  let body = '', y = 0, pageNo = 0;

  const header = () => {
    pageNo++;
    let s = `0.18 0.32 0.2 rg BT /F2 15 Tf ${MARGIN} ${PAGE_H - MARGIN - 6} Td ${pdfStr('Symbiz Network')} Tj ET\n`;
    s += `0 g BT /F2 12 Tf ${MARGIN} ${PAGE_H - MARGIN - 26} Td ${pdfStr(title)} Tj ET\n`;
    if (subtitle) s += `0.35 g BT /F1 9 Tf ${MARGIN} ${PAGE_H - MARGIN - 40} Td ${pdfStr(subtitle)} Tj ET\n`;
    s += `0.35 g BT /F1 8 Tf ${PAGE_W - MARGIN - 40} ${MARGIN - 16} Td ${pdfStr('Page ' + pageNo)} Tj ET\n`;
    y = PAGE_H - MARGIN - 64;
    s += '0.35 g ' + cols.map(c => cell(c.label.toUpperCase(), c, y, 'F2')).join('');
    s += rule(y - 5, 1.2, '0.18');
    y -= ROW_H + 2;
    return s + '0 g ';
  };
  const breakIfNeeded = () => {
    if (y < MARGIN + 10) { pages.push(body); body = header(); }
  };

  body = header();
  rows.forEach(r => {
    breakIfNeeded();
    body += cols.map((c, i) => cell(r[i], c, y, 'F1')).join('');
    body += rule(y - 5, 0.4, '0.82') + '0 g ';
    y -= ROW_H;
  });
  if (!rows.length) {
    body += `0.35 g BT /F1 ${SIZE} Tf ${MARGIN + 4} ${y.toFixed(2)} Td ${pdfStr('Nothing to show.')} Tj ET\n0 g `;
    y -= ROW_H;
  }
  if (footer) {
    breakIfNeeded();
    body += rule(y + ROW_H - 5, 1.2, '0.18') + '0 g ';
    body += cols.map((c, i) => cell(footer[i], c, y, 'F2')).join('');
    y -= ROW_H;
  }
  if (note) {
    breakIfNeeded();
    body += `0.35 g BT /F1 8 Tf ${MARGIN} ${(y - 8).toFixed(2)} Td ${pdfStr(note)} Tj ET\n`;
  }
  pages.push(body);

  return assemble(pages, PAGE_W, PAGE_H);
}

/** Pages of drawing commands → a PDF with Helvetica and Helvetica-Bold */
function assemble(pages, pageW, pageH) {
  // Objects: 1 catalog, 2 page tree, 3-4 fonts, then a page + content per page
  const objs = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((content, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });

  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* Words broken onto lines no wider than `width` */
function wrap(text, width, size) {
  const max = Math.max(10, Math.floor(width / (size * 0.52)));
  const lines = [];
  String(text == null ? '' : text).split(/\r?\n/).forEach(para => {
    let line = '';
    clean(para).split(' ').forEach(word => {
      while (word.length > max) { if (line) { lines.push(line); line = ''; } lines.push(word.slice(0, max)); word = word.slice(max); }
      const next = line ? line + ' ' + word : word;
      if (next.length > max) { lines.push(line); line = word; } else line = next;
    });
    lines.push(line);
  });
  return lines;
}

/**
 * A filled-in paper form, portrait: details in two columns, then each
 * question with its answer underneath (the Growth Ring Exit Interview).
 * @param {object} o
 * @param {string} o.title
 * @param {Array<[string, string]>} o.details   label, value pairs, two to a row
 * @param {Array<{q:string, a:string}>} o.questions
 * @param {Array<[string, string]>} [o.signoff]  e.g. Interviewer, Reviewed by
 * @param {string} [o.note]  small print at the foot
 * @returns {Buffer}
 */
function formPDF({ title, details = [], questions = [], signoff = [], note }) {
  const W = 612, H = 792, M = 54, BODY = 10.5, LINE = 14.5;
  const pages = [];
  let body = '', y = 0;
  const text = (t, x, yy, font, size, colour = '0 g') => `${colour} BT /${font} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfStr(t)} Tj ET\n`;
  const rule = yy => `0.75 G 0.5 w ${M} ${yy.toFixed(2)} m ${W - M} ${yy.toFixed(2)} l S\n`;
  const start = () => {
    body = text('Symbiz Network', M, H - M, 'F2', 11, '0.18 0.32 0.2 rg') + text(title, M, H - M - 24, 'F2', 17);
    y = H - M - 50;
  };
  const room = need => { if (y - need < M + 20) { pages.push(body); start(); } };
  start();
  const colW = (W - M * 2) / 2;
  for (let i = 0; i < details.length; i += 2) {
    room(LINE * 2);
    [details[i], details[i + 1]].forEach((d, k) => {
      if (!d) return;
      const x = M + k * colW;
      body += text(d[0] + ':', x, y, 'F2', BODY);
      body += text(fit(d[1] || '-', colW - 10 - textWidth(d[0] + ': ', BODY), BODY), x + textWidth(d[0] + ': ', BODY) + 4, y, 'F1', BODY);
    });
    y -= LINE + 6;
  }
  y -= 6;
  questions.forEach(({ q, a }) => {
    const lines = wrap(a && String(a).trim() ? a : '-', W - M * 2 - 10, BODY);
    room(LINE * 2 + Math.min(lines.length, 3) * LINE);
    body += text(q, M, y, 'F2', BODY + 0.5);
    y -= LINE + 2;
    lines.forEach(l => { room(LINE); body += text(l, M + 10, y, 'F1', BODY); y -= LINE; });
    body += rule(y + 4);
    y -= 12;
  });
  if (signoff.length) {
    y -= 8;
    for (let i = 0; i < signoff.length; i += 2) {
      room(LINE * 2);
      [signoff[i], signoff[i + 1]].forEach((d, k) => {
        if (!d) return;
        const x = M + k * colW;
        body += text(d[0] + ':', x, y, 'F2', BODY) + text(fit(d[1] || '', colW - 90, BODY), x + textWidth(d[0] + ': ', BODY) + 4, y, 'F1', BODY);
      });
      y -= LINE + 6;
    }
  }
  if (note) body += text(note, M, M - 10, 'F1', 7.5, '0.45 g');
  pages.push(body);
  return assemble(pages, W, H);
}

module.exports = { tablePDF, formPDF };
