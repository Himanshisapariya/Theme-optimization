function escapePdfText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r?\n/g, ' ');
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
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

export function buildRemovalReportPdf({ jobId, report, selectedIds, removedAt }) {
  const selectedSet = new Set(selectedIds);
  const removedEntries = report.entries.filter((entry) => selectedSet.has(entry.id));
  const grouped = new Map();

  for (const entry of removedEntries) {
    if (!grouped.has(entry.filePath)) {
      grouped.set(entry.filePath, []);
    }
    grouped.get(entry.filePath).push(entry);
  }

  const lines = [];
  lines.push('Shopify CSS Cleanup Report');
  lines.push(`Job ID: ${jobId}`);
  lines.push(`Removed at: ${removedAt || new Date().toISOString()}`);
  lines.push(`Total rules scanned: ${report.summary.totalRules}`);
  lines.push(`Used rules: ${report.summary.usedRules}`);
  lines.push(`Unused rules: ${report.summary.unusedRules}`);
  lines.push(`Selected for removal: ${selectedIds.length}`);
  lines.push('');

  if (grouped.size === 0) {
    lines.push('No selectors were removed.');
  } else {
    for (const [filePath, entries] of grouped.entries()) {
      lines.push(`File: ${filePath}`);
      for (const entry of entries) {
        lines.push(`- ${entry.selector}`);
      }
      lines.push('');
    }
  }

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const left = 40;
  const top = 800;
  const lineHeight = 14;
  const maxChars = 88;

  const contentLines = [];
  for (const line of lines) {
    const wrapped = wrapText(line, maxChars);
    contentLines.push(...wrapped, '');
  }

  const pages = [];
  let currentPage = [];
  let currentY = top;

  for (const line of contentLines) {
    if (currentY < 50) {
      pages.push(currentPage);
      currentPage = [];
      currentY = top;
    }
    currentPage.push({ text: line, y: currentY });
    currentY -= lineHeight;
  }
  pages.push(currentPage);

  let objects = [];
  let objectNumber = 1;
  const fontObject = objectNumber++;
  const pageObjects = [];
  const contentObjects = [];

  for (const page of pages) {
    const contentStream = [
      'BT',
      '/F1 11 Tf',
      ...page.map((line) => `1 0 0 1 ${left} ${line.y} Tm (${escapePdfText(line.text)}) Tj`),
      'ET'
    ].join('\n');
    const contentObject = objectNumber++;
    contentObjects.push({ id: contentObject, stream: contentStream });
    pageObjects.push(objectNumber++);
  }

  const pagesObject = objectNumber++;
  const catalogObject = objectNumber++;

  objects.push(`${fontObject} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`);
  for (const content of contentObjects) {
    objects.push(
      `${content.id} 0 obj << /Length ${Buffer.byteLength(content.stream, 'utf8')} >> stream\n${content.stream}\nendstream endobj`
    );
  }

  for (let i = 0; i < pages.length; i += 1) {
    const pageObjectId = pageObjects[i];
    const contentObjectId = contentObjects[i].id;
    objects.push(
      `${pageObjectId} 0 obj << /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjectId} 0 R >> endobj`
    );
  }

  objects.push(
    `${pagesObject} 0 obj << /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >> endobj`
  );
  objects.push(`${catalogObject} 0 obj << /Type /Catalog /Pages ${pagesObject} 0 R >> endobj`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer << /Size ${objects.length + 1} /Root ${catalogObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  pdf += xref + trailer;

  return Buffer.from(pdf, 'utf8');
}
