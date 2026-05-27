function escapePdfText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r?\n/g, ' ');
}

const PDF_WIDTH = 595.28;
const PDF_HEIGHT = 841.89;
const MARGIN_LEFT = 36;
const MARGIN_RIGHT = 36;
const CONTENT_WIDTH = PDF_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if ((current + ' ' + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current += ` ${word}`;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function splitCodeLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => wrapText(line, 86));
}

function severityFill(severity) {
  switch (severity) {
    case 'high':
      return { fill: 'FDEDEC', border: 'F5B7B1', text: 'A93226' };
    case 'medium':
      return { fill: 'FEF9E7', border: 'F5CBA7', text: '9A7D0A' };
    default:
      return { fill: 'EBF5FB', border: 'AED6F1', text: '1F618D' };
  }
}

function rgb(hex) {
  const normalized = String(hex || '000000').replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  return `${red.toFixed(3)} ${green.toFixed(3)} ${blue.toFixed(3)}`;
}

function createPage() {
  return { ops: [] };
}

function addRect(page, x, yTop, width, height, fillHex, strokeHex = null, lineWidth = 1) {
  const y = PDF_HEIGHT - yTop - height;
  page.ops.push(`${rgb(fillHex)} rg`);
  if (strokeHex) {
    page.ops.push(`${rgb(strokeHex)} RG`);
    page.ops.push(`${lineWidth} w`);
    page.ops.push(`${x} ${y} ${width} ${height} re B`);
  } else {
    page.ops.push(`${x} ${y} ${width} ${height} re f`);
  }
}

function addText(page, text, x, yTop, { font = 'F1', size = 10, color = '000000' } = {}) {
  const y = PDF_HEIGHT - yTop - size;
  page.ops.push(`BT /${font} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj ET`);
}

function addWrappedText(page, text, x, yTop, width, { font = 'F1', size = 10, color = '000000', lineHeight = 14 } = {}) {
  const maxChars = Math.max(18, Math.floor(width / (size * 0.5)));
  const lines = wrapText(text, maxChars);
  let cursor = yTop;

  for (const line of lines) {
    addText(page, line, x, cursor, { font, size, color });
    cursor += lineHeight;
  }

  return lines.length * lineHeight;
}

function addCodeBlock(page, text, x, yTop, width) {
  const paddingTop = 12;
  const paddingBottom = 10;
  const paddingLeft = 12;
  const codeLines = splitCodeLines(text);
  const lineHeight = 12;
  const height = paddingTop + paddingBottom + codeLines.length * lineHeight;

  addRect(page, x, yTop, width, height, 'F6F8FB', 'D7E0EA', 1);

  let cursor = yTop + paddingTop;
  for (const line of codeLines) {
    addText(page, line, x + paddingLeft, cursor, { font: 'F3', size: 9, color: '1F2937' });
    cursor += lineHeight;
  }

  return height;
}

function addSectionHeader(page, title, x, yTop, width, { subtitle = null } = {}) {
  const barHeight = subtitle ? 42 : 28;
  addRect(page, x, yTop, width, barHeight, '1F4B99');
  addText(page, title, x + 14, yTop + 8, { font: 'F2', size: subtitle ? 13 : 12, color: 'FFFFFF' });

  if (subtitle) {
    addText(page, subtitle, x + 14, yTop + 22, { font: 'F1', size: 9, color: 'DCE7F8' });
  }

  return barHeight;
}

function addMetricCard(page, x, yTop, width, height, label, value) {
  addRect(page, x, yTop, width, height, 'F4F7FB', 'D5DFEA', 1);
  addText(page, label, x + 12, yTop + 10, { font: 'F2', size: 9, color: '5B6B7F' });
  addText(page, value, x + 12, yTop + 28, { font: 'F2', size: 18, color: '1F2937' });
}

function groupByFile(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.filePath)) {
      grouped.set(entry.filePath, []);
    }
    grouped.get(entry.filePath).push(entry);
  }
  return grouped;
}

function addCommentBadge(page, x, yTop, label) {
  addRect(page, x, yTop, 88, 18, 'EAF1FB', 'C8D7EB', 1);
  addText(page, label, x + 8, yTop + 4, { font: 'F2', size: 8.5, color: '1F4B99' });
}

export function buildRemovalReportPdf({ jobId, report, selectedIds, selectedCommentIds = [], removedAt, performance = null }) {
  const selectedSet = new Set(selectedIds);
  const selectedCommentSet = new Set(selectedCommentIds);
  const removedEntries = report.entries.filter((entry) => selectedSet.has(entry.id));
  const removedCommentEntries = Array.isArray(report.commentEntries)
    ? report.commentEntries.filter((entry) => selectedCommentSet.has(entry.id))
    : [];
  const removedCssByFile = groupByFile(removedEntries);
  const removedCommentsByFile = groupByFile(removedCommentEntries);
  const recommendations = Array.isArray(performance?.recommendations) ? performance.recommendations : [];
  const unusedCssFiles = Array.isArray(performance?.unusedCssFiles) ? performance.unusedCssFiles : [];

  const pages = [createPage()];
  let pageIndex = 0;
  let cursorY = 0;

  function currentPage() {
    return pages[pageIndex];
  }

  function newPage() {
    pages.push(createPage());
    pageIndex += 1;
    cursorY = 36;
  }

  function ensureSpace(height) {
    if (cursorY + height > PDF_HEIGHT - 36) {
      newPage();
    }
  }

  function consume(height) {
    cursorY += height;
  }

  function addSpacer(height) {
    ensureSpace(height);
    consume(height);
  }

  function addParagraph(text, width, opts = {}) {
    const size = opts.size || 10;
    const lineHeight = opts.lineHeight || Math.round(size * 1.45);
    const maxChars = Math.max(18, Math.floor(width / (size * 0.52)));
    const lines = wrapText(text, maxChars);
    const height = lines.length * lineHeight;
    ensureSpace(height);

    let lineTop = cursorY;
    for (const line of lines) {
      addText(currentPage(), line, opts.x || MARGIN_LEFT, lineTop, {
        font: opts.font || 'F1',
        size,
        color: opts.color || '374151'
      });
      lineTop += lineHeight;
    }
    consume(height);
    return height;
  }

  function addSummaryCards() {
    const cardWidth = (CONTENT_WIDTH - 12) / 2;
    const cardHeight = 58;
    ensureSpace(cardHeight * 2 + 12);

    addMetricCard(currentPage(), MARGIN_LEFT, cursorY, cardWidth, cardHeight, 'Total rules', String(report.summary.totalRules));
    addMetricCard(currentPage(), MARGIN_LEFT + cardWidth + 12, cursorY, cardWidth, cardHeight, 'Unused rules', String(report.summary.unusedRules));
    addMetricCard(currentPage(), MARGIN_LEFT, cursorY + cardHeight + 12, cardWidth, cardHeight, 'Selected CSS', String(selectedIds.length));
    addMetricCard(currentPage(), MARGIN_LEFT + cardWidth + 12, cursorY + cardHeight + 12, cardWidth, cardHeight, 'Selected comments', String(selectedCommentIds.length));
    consume(cardHeight * 2 + 12);
  }

  function addRecommendationCard(recommendation) {
    const palette = severityFill(recommendation.severity);
    const maxWidth = CONTENT_WIDTH;
    const titleLines = wrapText(recommendation.title, 62);
    const detailLines = wrapText(recommendation.detail, 88);
    const height = 16 + titleLines.length * 14 + 8 + detailLines.length * 13 + 12;
    ensureSpace(height);
    addRect(currentPage(), MARGIN_LEFT, cursorY, maxWidth, height, palette.fill, palette.border, 1);

    let textTop = cursorY + 12;
    addText(currentPage(), recommendation.title, MARGIN_LEFT + 12, textTop, { font: 'F2', size: 12, color: palette.text });
    textTop += titleLines.length * 14 + 6;
    addWrappedText(currentPage(), recommendation.detail, MARGIN_LEFT + 12, textTop, maxWidth - 24, { font: 'F1', size: 10, color: '374151', lineHeight: 13 });
    consume(height + 10);
  }

  function addRemovedCssGroup(filePath, entries) {
    ensureSpace(28 + 10);
    addRect(currentPage(), MARGIN_LEFT, cursorY, CONTENT_WIDTH, 28, 'EAF1FB', 'C8D7EB', 1);
    addText(currentPage(), filePath, MARGIN_LEFT + 12, cursorY + 8, { font: 'F2', size: 11, color: '1F4B99' });
    consume(36);

    for (const entry of entries) {
      const selectorHeight = 18;
      const codeLines = splitCodeLines(entry.ruleText || entry.selector);
      const codeHeight = 12 + 10 + codeLines.length * 12;
      const blockHeight = selectorHeight + codeHeight + 14;
      ensureSpace(blockHeight);

      addText(currentPage(), entry.selector, MARGIN_LEFT + 12, cursorY + 2, { font: 'F2', size: 11, color: '0F172A' });
      consume(selectorHeight);
      addCodeBlock(currentPage(), entry.ruleText || entry.selector, MARGIN_LEFT + 12, cursorY, CONTENT_WIDTH - 24);
      consume(codeHeight + 8);
    }
  }

  function addRemovedCommentGroup(filePath, entries) {
    ensureSpace(28 + 10);
    addRect(currentPage(), MARGIN_LEFT, cursorY, CONTENT_WIDTH, 28, 'F7F0FF', 'D7C6F7', 1);
    addText(currentPage(), filePath, MARGIN_LEFT + 12, cursorY + 8, { font: 'F2', size: 11, color: '6B21A8' });
    consume(36);

    for (const entry of entries) {
      const badgeType = String(entry.commentType || 'comment');
      ensureSpace(18 + 18);

      addCommentBadge(currentPage(), MARGIN_LEFT + 12, cursorY + 2, badgeType);
      consume(22);
      const codeHeight = addCodeBlock(currentPage(), entry.commentText || entry.commentPreview || '', MARGIN_LEFT + 12, cursorY, CONTENT_WIDTH - 24);
      consume(codeHeight + 8);
    }
  }

  // Cover/header.
  addRect(currentPage(), 0, 0, PDF_WIDTH, 118, '173B7A');
  addText(currentPage(), 'Shopify CSS Cleanup Report', MARGIN_LEFT, 30, { font: 'F2', size: 22, color: 'FFFFFF' });
  addText(currentPage(), `Job ID: ${jobId}`, MARGIN_LEFT, 58, { font: 'F1', size: 10, color: 'DCE7F8' });
  addText(currentPage(), `Removed at: ${removedAt || new Date().toISOString()}`, MARGIN_LEFT, 72, { font: 'F1', size: 10, color: 'DCE7F8' });
  addText(currentPage(), `Selected CSS: ${selectedIds.length}  Selected comments: ${selectedCommentIds.length}`, MARGIN_LEFT, 86, { font: 'F1', size: 10, color: 'DCE7F8' });

  cursorY = 132;

  addSectionHeader(currentPage(), 'Cleanup overview', MARGIN_LEFT, cursorY, CONTENT_WIDTH, {
    subtitle: 'Summary of the scan, cleanup, and performance analysis'
  });
  consume(42);
  addSpacer(12);
  addSummaryCards();
  addSpacer(10);
  addParagraph('The report includes removed CSS rules, removed comment blocks, performance recommendations, and CSS files that do not appear to be linked anywhere in the theme.', CONTENT_WIDTH, { size: 10 });

  addSpacer(10);
  addSectionHeader(currentPage(), 'Performance recommendations', MARGIN_LEFT, cursorY, CONTENT_WIDTH, {
    subtitle: 'Shopify-focused suggestions generated from the uploaded theme'
  });
  consume(42);
  addSpacer(10);
  if (recommendations.length === 0) {
    addParagraph('No performance recommendations were generated for this theme.', CONTENT_WIDTH, { size: 10 });
  } else {
    for (const recommendation of recommendations) {
      addRecommendationCard(recommendation);
    }
  }

  addSpacer(6);
  addSectionHeader(currentPage(), 'CSS files not linked anywhere', MARGIN_LEFT, cursorY, CONTENT_WIDTH, {
    subtitle: 'Files that do not appear to be referenced in the scanned theme code'
  });
  consume(42);
  addSpacer(10);
  if (unusedCssFiles.length === 0) {
    addParagraph('No completely unlinked CSS files were found.', CONTENT_WIDTH, { size: 10 });
  } else {
    for (const file of unusedCssFiles) {
      ensureSpace(34);
      addRect(currentPage(), MARGIN_LEFT, cursorY, CONTENT_WIDTH, 34, 'F7FAFD', 'D7E0EA', 1);
      addText(currentPage(), file.filePath, MARGIN_LEFT + 12, cursorY + 8, { font: 'F2', size: 10.5, color: '1F2937' });
      addText(currentPage(), `${Math.round((file.bytes || 0) / 1024)} KB`, MARGIN_LEFT + 12, cursorY + 21, { font: 'F1', size: 9.5, color: '64748B' });
      consume(42);
    }
  }

  addSpacer(8);
  addSectionHeader(currentPage(), 'Removed CSS rules', MARGIN_LEFT, cursorY, CONTENT_WIDTH, {
    subtitle: 'Each removed selector and its CSS block, grouped by source file'
  });
  consume(42);
  addSpacer(10);
  if (removedEntries.length === 0) {
    addParagraph('No selectors were removed.', CONTENT_WIDTH, { size: 10 });
  } else {
    for (const [filePath, entries] of removedCssByFile.entries()) {
      addRemovedCssGroup(filePath, entries);
      addSpacer(8);
    }
  }

  addSpacer(8);
  addSectionHeader(currentPage(), 'Removed commented code', MARGIN_LEFT, cursorY, CONTENT_WIDTH, {
    subtitle: 'Commented CSS, JS, Liquid, and HTML blocks removed during cleanup'
  });
  consume(42);
  addSpacer(10);
  if (removedCommentEntries.length === 0) {
    addParagraph('No commented code blocks were removed.', CONTENT_WIDTH, { size: 10 });
  } else {
    for (const [filePath, entries] of removedCommentsByFile.entries()) {
      addRemovedCommentGroup(filePath, entries);
      addSpacer(8);
    }
  }

  const fontObject = 1;
  const boldFontObject = 2;
  const codeFontObject = 3;
  const objectMap = new Map();
  const pageObjects = [];
  const contentObjects = [];
  let objectNumber = 4;

  for (const page of pages) {
    const stream = page.ops.join('\n');
    const contentObject = objectNumber++;
    const pageObject = objectNumber++;
    contentObjects.push({ id: contentObject, stream });
    pageObjects.push(pageObject);
  }

  const pagesObject = objectNumber++;
  const catalogObject = objectNumber++;

  objectMap.set(fontObject, `${fontObject} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`);
  objectMap.set(boldFontObject, `${boldFontObject} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj`);
  objectMap.set(codeFontObject, `${codeFontObject} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj`);

  for (const content of contentObjects) {
    objectMap.set(content.id, `${content.id} 0 obj << /Length ${Buffer.byteLength(content.stream, 'utf8')} >> stream\n${content.stream}\nendstream endobj`);
  }

  for (let index = 0; index < pages.length; index += 1) {
    const pageObjectId = pageObjects[index];
    const contentObjectId = contentObjects[index].id;
    objectMap.set(
      pageObjectId,
      `${pageObjectId} 0 obj << /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${PDF_WIDTH} ${PDF_HEIGHT}] /Resources << /Font << /F1 ${fontObject} 0 R /F2 ${boldFontObject} 0 R /F3 ${codeFontObject} 0 R >> >> /Contents ${contentObjectId} 0 R >> endobj`
    );
  }

  objectMap.set(pagesObject, `${pagesObject} 0 obj << /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >> endobj`);
  objectMap.set(catalogObject, `${catalogObject} 0 obj << /Type /Catalog /Pages ${pagesObject} 0 R >> endobj`);

  const objects = Array.from(objectMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, object]) => object);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }

  const trailer = `trailer << /Size ${objects.length + 1} /Root ${catalogObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  pdf += xref + trailer;

  return Buffer.from(pdf, 'utf8');
}
