import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

const TEXT_EXTENSIONS = new Set(['.liquid', '.html', '.js']);
const STYLE_BLOCK_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK_REGEX = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const CSS_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
const JS_BLOCK_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
const JS_LINE_COMMENT_REGEX = /^[ \t]*\/\/.*(?:\r?\n|$)/gm;
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const LIQUID_COMMENT_REGEX = /{%\s*comment\s*%}[\s\S]*?{%\s*endcomment\s*%}/gi;
const IFRAME_TAG_REGEX = /<iframe\b[^>]*>/gi;
const LINK_STYLESHEET_REGEX = /<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi;
const SCRIPT_SRC_REGEX = /<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi;
const INLINE_STYLE_REGEX = /\sstyle=["'][^"']*["']/gi;
const FONT_FACE_REGEX = /@font-face\b/gi;

const LIQUID_DOC_COMMENT_PATTERN = /Accepts:|Usage:/i;
const TAILWIND_CONFIG_FILE_REGEX = /(?:^|\/)tailwind\.config\.(?:js|cjs|mjs|ts)$/i;
const TAILWIND_CSS_DIRECTIVE_REGEX = /@tailwind\s+(base|components|utilities)\b/i;
const TAILWIND_IMPORT_REGEX = /@import\s+["']tailwindcss(?:\/[^"']+)?["']/i;
const DEFAULT_PROTECTED_SELECTOR_PATTERNS = [
  'swiper',
  'slider',
  'form',
  'page-width',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  '.h0',
  '.h1',
  '.h2',
  '.h3',
  '.h4',
  '.h5',
  '--left',
  '--right',
  '--center'
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLiquidDocComment(text) {
  return LIQUID_DOC_COMMENT_PATTERN.test(text);
}

function buildBoundaryPattern(token, caseInsensitive = false) {
  const flags = caseInsensitive ? 'i' : 'g';
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(token)}([^A-Za-z0-9_-]|$)`, flags);
}

function stripLiquidTags(content) {
  return content.replace(/({{[\s\S]*?}}|{%\s*[\s\S]*?%})/g, ' ');
}

function stripStyleBlocks(content) {
  return content.replace(STYLE_BLOCK_REGEX, ' ');
}

function extractLiquidDynamic(content) {
  const segments = [];
  const pattern = /({{[\s\S]*?}}|{%\s*[\s\S]*?%})/g;
  let match;
  while ((match = pattern.exec(content))) {
    segments.push(match[0].slice(2, -2));
  }
  return segments.join(' ');
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

function createCorpusMatcher(staticCorpus, dynamicCorpus) {
  return {
    has(token, caseInsensitive = false) {
      if (!token) return false;
      const staticPattern = buildBoundaryPattern(token, caseInsensitive);
      if (staticPattern.test(staticCorpus)) return { found: true, source: 'static' };
      const dynamicPattern = buildBoundaryPattern(token, caseInsensitive);
      if (dynamicPattern.test(dynamicCorpus)) return { found: true, source: 'dynamic' };
      return { found: false, source: 'none' };
    }
  };
}

function buildFileReferenceCandidates(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').trim();
  if (!normalized) return [];

  const baseName = path.posix.basename(normalized).toLowerCase();
  const baseStem = baseName.replace(/\.css$/i, '');
  const directoryStem = normalized.replace(/^.*\//, '').replace(/\.css$/i, '').toLowerCase();
  const pathLower = normalized.toLowerCase();

  return [...new Set([
    baseName,
    baseStem,
    directoryStem,
    pathLower,
    `assets/${baseName}`,
    `assets/${baseStem}`
  ].filter(Boolean))];
}

function isFileReferencedInCorpus(relativePath, matcher) {
  const candidates = buildFileReferenceCandidates(relativePath);
  if (candidates.length === 0) return false;

  for (const candidate of candidates) {
    const exact = matcher.has(candidate, true);
    if (exact.found) {
      return true;
    }
  }

  return false;
}

function normalizeProtectedPatterns(patterns) {
  const merged = [
    ...DEFAULT_PROTECTED_SELECTOR_PATTERNS,
    ...(Array.isArray(patterns) ? patterns : [])
  ];
  return [...new Set(
    merged
      .map((pattern) => String(pattern || '').trim())
      .filter(Boolean)
  )];
}

function classTokenMatchesPattern(token, pattern) {
  const normalizedToken = String(token || '').toLowerCase();
  const normalizedPattern = String(pattern || '').toLowerCase();
  if (!normalizedToken || !normalizedPattern) return false;
  if (normalizedPattern.startsWith('--')) {
    return normalizedToken.includes(normalizedPattern);
  }
  if (normalizedToken === normalizedPattern) {
    return true;
  }
  return new RegExp(`(^|[-_])${escapeRegExp(normalizedPattern)}($|[-_])`, 'i').test(normalizedToken);
}

function tagTokenMatchesPattern(token, pattern) {
  const normalizedToken = String(token || '').toLowerCase();
  const normalizedPattern = String(pattern || '').toLowerCase();
  return Boolean(normalizedToken && normalizedPattern && normalizedToken === normalizedPattern);
}

function selectorMatchesProtected(selector, protectedPatterns) {
  const normalizedSelector = String(selector || '');
  if (!normalizedSelector || protectedPatterns.length === 0) return false;
  const normalizedLower = normalizedSelector.toLowerCase();
  const classTokens = extractTokensFromSelector(normalizedSelector)
    .filter((token) => token.type === 'class')
    .map((token) => String(token.value || '').toLowerCase());
  const tagTokens = extractTokensFromSelector(normalizedSelector)
    .filter((token) => token.type === 'tag')
    .map((token) => String(token.value || '').toLowerCase());

  for (const rawPattern of protectedPatterns) {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) continue;

    const lowerPattern = pattern.toLowerCase();
    const looksLikeSelector = /[.#\s>+~\[:]/.test(pattern);

    if (looksLikeSelector) {
      if (normalizedSelector.includes(pattern) || normalizedLower.includes(lowerPattern)) {
        return true;
      }
      continue;
    }

    if (classTokens.some((token) => classTokenMatchesPattern(token, lowerPattern))) {
      return true;
    }

    if (tagTokens.some((token) => tagTokenMatchesPattern(token, lowerPattern))) {
      return true;
    }

    if (normalizedLower.includes(`.${lowerPattern}`) || normalizedLower.includes(`#${lowerPattern}`)) {
      return true;
    }
  }

  return false;
}

function extractTokensFromSelector(selector) {
  const tokens = [];

  try {
    selectorParser((selectors) => {
      selectors.walk((node) => {
        if (node.type === 'class') {
          tokens.push({ type: 'class', value: node.value, caseInsensitive: true });
        }
        if (node.type === 'id') {
          tokens.push({ type: 'id', value: node.value, caseInsensitive: true });
        }
        if (node.type === 'tag') {
          const value = node.value.trim();
          if (value && value !== '*') {
            tokens.push({ type: 'tag', value, caseInsensitive: true });
          }
        }
        if (node.type === 'attribute') {
          const name = String(node.attribute || '').trim();
          const value = String(node.value || '').trim().replace(/^["']|["']$/g, '');
          if (name) {
            tokens.push({ type: 'attribute', value: name, caseInsensitive: true });
          }
          if (value) {
            tokens.push({ type: 'attribute-value', value, caseInsensitive: false });
          }
        }
      });
    }).processSync(selector);
  } catch {
    return tokens;
  }

  return tokens;
}

function analyzeSelector(selector, matcher) {
  const tokens = extractTokensFromSelector(selector);
  if (tokens.length === 0) {
    return { status: 'used', matchedBy: 'unknown', tokens: [] };
  }

  for (const token of tokens) {
    const result = matcher.has(token.value, token.caseInsensitive);
    if (result.found) {
      return { status: 'used', matchedBy: result.source, tokens };
    }
  }

  return { status: 'unused', matchedBy: 'none', tokens };
}

function getSourceKey(relativePath, kind, index = 0) {
  return kind === 'style-block' ? `${relativePath}::style-block:${index}` : relativePath;
}

function getAssetKind(relativePath) {
  const lowerPath = String(relativePath || '').toLowerCase();

  if (lowerPath.endsWith('.css.liquid')) {
    return 'css-liquid';
  }

  if (lowerPath.endsWith('.js.liquid')) {
    return 'js-liquid';
  }

  if (lowerPath.endsWith('.html.liquid')) {
    return 'html-liquid';
  }

  if (lowerPath.endsWith('.css')) {
    return 'css';
  }

  if (lowerPath.endsWith('.js')) {
    return 'js';
  }

  if (lowerPath.endsWith('.html')) {
    return 'html';
  }

  if (lowerPath.endsWith('.liquid')) {
    return 'liquid';
  }

  return 'text';
}

function extractStyleBlocks(content) {
  const blocks = [];
  let match;
  let index = 0;

  STYLE_BLOCK_REGEX.lastIndex = 0;
  while ((match = STYLE_BLOCK_REGEX.exec(content))) {
    blocks.push({
      index,
      fullMatch: match[0],
      css: match[1],
      start: match.index,
      end: match.index + match[0].length
    });
    index += 1;
  }

  return blocks;
}

function extractScriptBlocks(content) {
  const blocks = [];
  let match;
  let index = 0;

  SCRIPT_BLOCK_REGEX.lastIndex = 0;
  while ((match = SCRIPT_BLOCK_REGEX.exec(content))) {
    blocks.push({
      index,
      fullMatch: match[0],
      js: match[1],
      start: match.index,
      end: match.index + match[0].length
    });
    index += 1;
  }

  return blocks;
}

function createCommentEntry({ sourceMeta, commentType, commentText, start, end, commentIndex, lineCount }) {
  const resolvedLineCount = Number.isFinite(lineCount) && lineCount > 0
    ? lineCount
    : String(commentText || '').split(/\r?\n/).length;
  return {
    id: `${sourceMeta.sourceKey}:comment:${commentIndex}`,
    filePath: sourceMeta.filePath,
    fileName: sourceMeta.fileName,
    sourceType: 'comment',
    commentType,
    commentText,
    commentPreview: String(commentText || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    lineCount: resolvedLineCount,
    start,
    end,
    commentIndex,
    sourceKey: sourceMeta.sourceKey,
    sourceLabel: sourceMeta.sourceLabel,
    isLiquidDoc: commentType === 'liquid-comment' && isLiquidDocComment(commentText)
  };
}

function collectLineCommentBlocks(content, sourceMeta, baseOffset = 0, startIndex = 0) {
  const entries = [];
  const text = String(content || '');
  const lineRegex = /[^\r\n]*(?:\r?\n|$)/g;
  let commentIndex = startIndex;
  let blockStart = -1;
  let blockEnd = -1;
  let blockLines = 0;
  let match;

  const flushBlock = () => {
    if (blockStart === -1 || blockEnd === -1) return;
    const commentText = text.slice(blockStart, blockEnd);
    entries.push(createCommentEntry({
      sourceMeta,
      commentType: 'js-line-comment-block',
      commentText,
      start: baseOffset + blockStart,
      end: baseOffset + blockEnd,
      commentIndex,
      lineCount: blockLines
    }));
    commentIndex += 1;
    blockStart = -1;
    blockEnd = -1;
    blockLines = 0;
  };

  lineRegex.lastIndex = 0;
  while ((match = lineRegex.exec(text))) {
    const start = match.index;
    const end = match.index + match[0].length;
    const lineText = match[0].replace(/\r?\n$/, '');
    const isCommentLine = /^[ \t]*\/\/.*$/.test(lineText);
    const isBlankLine = /^[ \t]*$/.test(lineText);

    if (lineText.length === 0 && end === text.length) {
      break;
    }

    if (isCommentLine) {
      if (blockStart === -1) {
        blockStart = start;
      }
      blockEnd = end;
      blockLines += 1;
      continue;
    }

    if (isBlankLine && blockStart !== -1) {
      blockEnd = end;
      continue;
    }

    if (blockStart !== -1) {
      flushBlock();
    }
  }

  flushBlock();
  return entries;
}

function collectCommentEntriesFromText(content, sourceMeta, patterns, baseOffset = 0, startIndex = 0) {
  const entries = [];
  let commentIndex = startIndex;

  for (const { type, regex } of patterns) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content))) {
      entries.push(createCommentEntry({
        sourceMeta,
        commentType: type,
        commentText: match[0],
        start: baseOffset + match.index,
        end: baseOffset + match.index + match[0].length,
        commentIndex
      }));
      commentIndex += 1;
    }
  }

  return entries;
}

function isSmallCommentEntry(entry, maxLines = 2) {
  return Number(entry?.lineCount || 0) > 0 && Number(entry.lineCount) <= maxLines;
}

function buildWhitespaceFlexiblePattern(text) {
  const parts = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part));

  if (parts.length === 0) {
    return null;
  }

  return new RegExp(parts.join('\\s+'));
}

function removeFirstTextMatch(content, text) {
  const source = String(content || '');
  const target = String(text || '');
  if (!target) {
    return source;
  }

  const exactIndex = source.indexOf(target);
  if (exactIndex !== -1) {
    return `${source.slice(0, exactIndex)}${source.slice(exactIndex + target.length)}`;
  }

  const pattern = buildWhitespaceFlexiblePattern(target);
  if (!pattern) {
    return source;
  }

  const match = source.match(pattern);
  if (!match || typeof match.index !== 'number') {
    return source;
  }

  return `${source.slice(0, match.index)}${source.slice(match.index + match[0].length)}`;
}

function removeCommentEntriesFromText(content, commentEntries) {
  if (!Array.isArray(commentEntries) || commentEntries.length === 0) {
    return content;
  }

  let next = String(content);
  for (const entry of commentEntries) {
    const text = String(entry?.commentText || '');
    if (!text) continue;
    next = removeFirstTextMatch(next, text);
  }

  return next;
}

function extractOpeningTag(content, tagName, startIndex) {
  const text = String(content || '');
  const lowerTagName = String(tagName || '').toLowerCase();
  let quoteChar = null;
  let liquidClose = null;

  for (let index = startIndex; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (liquidClose) {
      if (current === liquidClose[0] && next === liquidClose[1]) {
        liquidClose = null;
        index += 1;
      }
      continue;
    }

    if (quoteChar) {
      if (current === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (current === '"' || current === '\'') {
      quoteChar = current;
      continue;
    }

    if (current === '{' && next === '{') {
      liquidClose = ['}', '}'];
      index += 1;
      continue;
    }

    if (current === '{' && next === '%') {
      liquidClose = ['%', '}'];
      index += 1;
      continue;
    }

    if (current === '>') {
      return { tag: text.slice(startIndex, index + 1), endIndex: index + 1 };
    }

    if (current === '<' && index !== startIndex) {
      const maybeTag = text.slice(index + 1, index + 1 + lowerTagName.length).toLowerCase();
      if (maybeTag === lowerTagName) {
        return { tag: text.slice(startIndex, index), endIndex: index };
      }
    }
  }

  return { tag: text.slice(startIndex), endIndex: text.length };
}

function extractTags(content, tagName) {
  const text = String(content || '');
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b`, 'gi');
  const tags = [];
  let match;

  while ((match = pattern.exec(text))) {
    const extracted = extractOpeningTag(text, tagName, match.index);
    if (extracted?.tag) {
      tags.push({
        tag: extracted.tag,
        startIndex: match.index,
        endIndex: extracted.endIndex
      });
    }
  }

  return tags;
}

function hasAttribute(tag, attributeName) {
  const attributePattern = new RegExp(`(?:^|\\s)${escapeRegExp(attributeName)}(?:\\s*=|\\s|>|$)`, 'i');
  return attributePattern.test(tag);
}

function countMatches(source, regex) {
  const matches = String(source || '').match(regex);
  return matches ? matches.length : 0;
}

function createPerformanceTracker() {
  return {
    tailwindDetected: false,
    tailwindEvidence: [],
    cssFileCount: 0,
    cssBytes: 0,
    jsFileCount: 0,
    markupFileCount: 0,
    imageTags: 0,
    imageTagsMissingDimensions: 0,
    imageTagsMissingLazy: 0,
    iframeTags: 0,
    iframeTagsMissingLazy: 0,
    stylesheetLinks: 0,
    scriptSrcTags: 0,
    inlineStyleAttributes: 0,
    fontFaceCount: 0,
    cssFileStats: [],
    jsFileStats: [],
    imagesMissingDimensions: [],
    imagesMissingLazy: []
  };
}

function buildPerformanceRecommendations(report, tracker) {
  const recommendations = [];
  const totalRules = report.summary?.totalRules || 0;
  const unusedRules = report.summary?.unusedRules || 0;
  const estimatedSavingsBytes = report.summary?.estimatedSavingsBytes || 0;
  const unusedCssFiles = Array.isArray(report.performance?.unusedCssFiles)
    ? report.performance.unusedCssFiles
    : [];
  const unusedJsFiles = Array.isArray(report.performance?.unusedJsFiles)
    ? report.performance.unusedJsFiles
    : [];
  const cssFileStats = [...(tracker.cssFileStats || [])].sort((a, b) => b.bytes - a.bytes);
  const topCssFile = cssFileStats[0] || null;
  const topUnusedFile = report.entries
    .filter((entry) => entry.status === 'unused' && entry.sourceType === 'css')
    .reduce((acc, entry) => {
      const current = acc.get(entry.filePath) || { total: 0, unused: 0 };
      current.total += 1;
      current.unused += 1;
      acc.set(entry.filePath, current);
      return acc;
    }, new Map());

  let worstUnusedFile = null;
  for (const [filePath, counts] of topUnusedFile.entries()) {
    const ratio = counts.total > 0 ? counts.unused / counts.total : 0;
    if (!worstUnusedFile || ratio > worstUnusedFile.ratio || (ratio === worstUnusedFile.ratio && counts.unused > worstUnusedFile.unused)) {
      worstUnusedFile = { filePath, ratio, unused: counts.unused, total: counts.total };
    }
  }

  if (unusedRules > 0) {
    recommendations.push({
      id: 'unused-css',
      severity: 'high',
      title: 'Remove unused CSS and extract critical CSS',
      detail: `Found ${unusedRules} unused selector(s), so you can safely trim CSS and consider inlining critical styles for above-the-fold content.`
    });
  }

  if (totalRules >= 300 || tracker.cssFileCount >= 8) {
    recommendations.push({
      id: 'css-splitting',
      severity: 'medium',
      title: 'Split large CSS files by template or section',
      detail: `The theme has ${tracker.cssFileCount} CSS file(s) and ${totalRules} selector(s). Loading only page-specific CSS can reduce render-blocking bytes.`
    });
  }

  if (tracker.stylesheetLinks >= 3) {
    recommendations.push({
      id: 'stylesheet-blocking',
      severity: 'medium',
      title: 'Review render-blocking stylesheets',
      detail: `Detected ${tracker.stylesheetLinks} stylesheet link tag(s). Consider consolidating non-critical CSS and preloading the files that matter most.`
    });
  }

  if (estimatedSavingsBytes >= 50 * 1024) {
    recommendations.push({
      id: 'css-savings',
      severity: 'high',
      title: 'Ship a smaller CSS payload',
      detail: `Estimated savings are ${Math.round(estimatedSavingsBytes / 1024)} KB, which is large enough to improve first paint and reduce style recalculation.`
    });
  }

  if (tracker.imageTags > 0 && tracker.imageTagsMissingDimensions > 0) {
    recommendations.push({
      id: 'image-dimensions',
      severity: 'high',
      title: 'Add width and height to images',
      detail: `${tracker.imageTagsMissingDimensions} image tag(s) are missing dimensions, which can contribute to layout shift.`
    });
  }

  if (tracker.imageTags > 0 && tracker.imageTagsMissingLazy > 0) {
    recommendations.push({
      id: 'image-lazy-load',
      severity: 'medium',
      title: 'Lazy-load below-the-fold images',
      detail: `${tracker.imageTagsMissingLazy} image tag(s) do not declare lazy loading. Use it for non-critical imagery and iframe embeds.`
    });
  }

  if (tracker.scriptSrcTags >= 5) {
    recommendations.push({
      id: 'script-audit',
      severity: 'medium',
      title: 'Audit theme JavaScript delivery',
      detail: `Detected ${tracker.scriptSrcTags} script tag(s) with a source. Review which ones can be deferred or loaded conditionally.`
    });
  }

  if (tracker.fontFaceCount >= 3) {
    recommendations.push({
      id: 'font-optimization',
      severity: 'low',
      title: 'Trim font families and weights',
      detail: `Detected ${tracker.fontFaceCount} @font-face declarations. Reducing font variants can improve loading and text rendering.`
    });
  }

  if (tracker.inlineStyleAttributes >= 8) {
    recommendations.push({
      id: 'inline-styles',
      severity: 'low',
      title: 'Move repeated inline styles into CSS',
      detail: `Detected ${tracker.inlineStyleAttributes} inline style attribute(s). Moving repeated patterns into CSS makes themes easier to maintain and can reduce markup weight.`
    });
  }

  if (topCssFile && topCssFile.bytes >= 100 * 1024) {
    recommendations.push({
      id: 'largest-css',
      severity: 'medium',
      title: 'Inspect the largest CSS file first',
      detail: `${topCssFile.filePath} is the largest stylesheet at ${Math.round(topCssFile.bytes / 1024)} KB, so it is a good candidate for section splitting or lazy loading.`
    });
  }

  if (worstUnusedFile && worstUnusedFile.unused >= 10 && worstUnusedFile.ratio >= 0.35) {
    recommendations.push({
      id: 'file-hotspot',
      severity: 'medium',
      title: 'Target the biggest unused-CSS hotspot',
      detail: `${worstUnusedFile.filePath} has ${worstUnusedFile.unused} unused selector(s) out of ${worstUnusedFile.total}, making it the highest-priority file for cleanup.`
    });
  }

  if (unusedCssFiles.length > 0) {
    recommendations.push({
      id: 'unused-css-files',
      severity: 'high',
      title: 'Remove CSS files that are not linked anywhere',
      detail: `${unusedCssFiles.length} CSS file(s) do not appear to be referenced anywhere in the theme, so they are likely safe candidates for deletion after a quick manual check.`
    });
  }

  if (unusedJsFiles.length > 0) {
    recommendations.push({
      id: 'unused-js-files',
      severity: 'medium',
      title: 'Remove JS files that are not linked anywhere',
      detail: `${unusedJsFiles.length} JS file(s) do not appear to be referenced anywhere in the theme. Review and delete any that are truly unused.`
    });
  }

  return recommendations;
}

function markTailwindSignal(tracker, filePath, reason) {
  tracker.tailwindDetected = true;
  if (!Array.isArray(tracker.tailwindEvidence)) {
    tracker.tailwindEvidence = [];
  }
  if (tracker.tailwindEvidence.length < 5) {
    tracker.tailwindEvidence.push({
      filePath,
      reason
    });
  }
}

function scanCssSource(cssText, sourceMeta, matcher) {
  const entries = [];
  const hasLiquidSyntax = /({{[\s\S]*?}}|{%\s*[\s\S]*?%})/.test(cssText);
  const parseSafeCss = cssText.replace(/({{[\s\S]*?}}|{%\s*[\s\S]*?%})/g, ' ');
  const root = postcss.parse(parseSafeCss, { from: sourceMeta.sourceLabel });
  let sourceRuleIndex = 0;

  root.walkRules((rule) => {
    const selectors = Array.isArray(rule.selectors) ? rule.selectors : [rule.selector];
    const ruleSize = Buffer.byteLength(rule.toString());
    const selectorShare = Math.max(1, Math.round(ruleSize / Math.max(1, selectors.length)));

    selectors.forEach((selector, selectorIndex) => {
      const analysis = hasLiquidSyntax || /({{[\s\S]*?}}|{%\s*[\s\S]*?%})/.test(selector)
        ? { status: 'used', matchedBy: 'protected-liquid' }
        : analyzeSelector(selector, matcher);
      entries.push({
        id: `${sourceMeta.sourceKey}:${sourceRuleIndex}:${selectorIndex}`,
        filePath: sourceMeta.filePath,
        fileName: sourceMeta.fileName,
        selector,
        ruleText: rule.toString(),
        ruleIndex: sourceRuleIndex,
        selectorIndex,
        status: analysis.status,
        matchedBy: analysis.matchedBy,
        estimatedBytes: selectorShare,
        fileByteSize: Buffer.byteLength(cssText),
        sourceType: sourceMeta.sourceType,
        sourceKey: sourceMeta.sourceKey,
        embeddedIndex: sourceMeta.embeddedIndex ?? null,
        sourceLabel: sourceMeta.sourceLabel
      });
    });

    sourceRuleIndex += 1;
  });

  return entries;
}

export async function scanWorkspace(sourceDir) {
  const filePatterns = ['**/*.{liquid,html,js,css}'];
  const files = await fg(filePatterns, {
    cwd: sourceDir,
    onlyFiles: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/backups/**', '**/uploads/**', '**/cleaned/**']
  });

  const textFiles = files.filter((file) => {
    const ext = path.extname(file).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
  });

  const staticParts = [];
  const dynamicParts = [];
  const tracker = createPerformanceTracker();
  const commentEntries = [];
  let commentIndex = 0;

  for (const relativePath of textFiles) {
    const absolutePath = path.join(sourceDir, relativePath);
    const content = await readText(absolutePath);
    const assetKind = getAssetKind(relativePath);
    const ext = path.extname(relativePath).toLowerCase();

    if (TAILWIND_CONFIG_FILE_REGEX.test(relativePath)) {
      markTailwindSignal(tracker, relativePath, 'Tailwind config file');
    }

    if (assetKind === 'css' || assetKind === 'css-liquid') {
      staticParts.push(stripLiquidTags(stripStyleBlocks(content)));
      if (TAILWIND_CSS_DIRECTIVE_REGEX.test(content) || TAILWIND_IMPORT_REGEX.test(content)) {
        markTailwindSignal(tracker, relativePath, 'Tailwind CSS directive');
      }
      if (assetKind === 'css-liquid') {
        dynamicParts.push(extractLiquidDynamic(content));
      }
    } else if (assetKind === 'js' || assetKind === 'js-liquid') {
      tracker.jsFileStats.push({ filePath: relativePath, bytes: Buffer.byteLength(content) });
      staticParts.push(stripLiquidTags(content));
      if (assetKind === 'js-liquid') {
        dynamicParts.push(extractLiquidDynamic(content));
      }
    } else if (assetKind === 'html' || assetKind === 'html-liquid') {
      staticParts.push(stripStyleBlocks(content));
      if (assetKind === 'html-liquid') {
        dynamicParts.push(extractLiquidDynamic(content));
      }
    } else if (ext === '.liquid') {
      staticParts.push(stripStyleBlocks(stripLiquidTags(content)));
      dynamicParts.push(extractLiquidDynamic(content));
    } else {
      staticParts.push(stripStyleBlocks(content));
    }

    if (assetKind === 'js' || assetKind === 'js-liquid') {
      commentEntries.push(
        ...collectLineCommentBlocks(content, {
          filePath: relativePath,
          fileName: path.basename(relativePath),
          sourceType: 'js',
          sourceKey: getSourceKey(relativePath, 'comment')
        }, 0, commentIndex)
      );
      commentIndex = commentEntries.length;
      commentEntries.push(
        ...collectCommentEntriesFromText(content, {
          filePath: relativePath,
          fileName: path.basename(relativePath),
          sourceType: 'js',
          sourceKey: getSourceKey(relativePath, 'comment')
        }, [
          { type: 'js-block-comment', regex: JS_BLOCK_COMMENT_REGEX }
        ], 0, commentIndex)
      );
      commentIndex = commentEntries.length;
    }

    if (assetKind === 'css' || assetKind === 'css-liquid') {
      commentEntries.push(
        ...collectCommentEntriesFromText(content, {
          filePath: relativePath,
          fileName: path.basename(relativePath),
          sourceType: 'css',
          sourceKey: getSourceKey(relativePath, 'comment')
        }, [
          { type: 'css-comment', regex: CSS_COMMENT_REGEX }
        ], 0, commentIndex)
      );
      commentIndex = commentEntries.length;
    }

    if (assetKind === 'html' || assetKind === 'html-liquid' || assetKind === 'liquid') {
      commentEntries.push(
        ...collectCommentEntriesFromText(content, {
          filePath: relativePath,
          fileName: path.basename(relativePath),
          sourceType: 'markup',
          sourceKey: getSourceKey(relativePath, 'comment')
        }, [
          { type: 'html-comment', regex: HTML_COMMENT_REGEX },
          { type: 'liquid-comment', regex: LIQUID_COMMENT_REGEX }
        ], 0, commentIndex)
      );
      commentIndex = commentEntries.length;

      tracker.markupFileCount += 1;
      const iframeTags = extractTags(content, 'iframe');
      tracker.iframeTags += iframeTags.length;
      tracker.stylesheetLinks += countMatches(content, LINK_STYLESHEET_REGEX);
      tracker.scriptSrcTags += countMatches(content, SCRIPT_SRC_REGEX);
      tracker.inlineStyleAttributes += countMatches(content, INLINE_STYLE_REGEX);

      const missingDimsLines = [];
      const missingLazyLines = [];
      const imgTags = extractTags(content, 'img');
      for (const { tag, startIndex } of imgTags) {
        tracker.imageTags += 1;
        const lineNumber = content.slice(0, startIndex).split('\n').length;
        if (!hasAttribute(tag, 'width') || !hasAttribute(tag, 'height')) {
          tracker.imageTagsMissingDimensions += 1;
          missingDimsLines.push(lineNumber);
        }
        if (!/loading\s*=\s*["']lazy["']/i.test(tag.toLowerCase())) {
          tracker.imageTagsMissingLazy += 1;
          missingLazyLines.push(lineNumber);
        }
      }
      if (missingDimsLines.length > 0) {
        tracker.imagesMissingDimensions.push({ filePath: relativePath, fileName: path.basename(relativePath), lines: missingDimsLines });
      }
      if (missingLazyLines.length > 0) {
        tracker.imagesMissingLazy.push({ filePath: relativePath, fileName: path.basename(relativePath), lines: missingLazyLines });
      }

      for (const { tag } of iframeTags) {
        const lowerTag = tag.toLowerCase();
        if (!/loading\s*=\s*["']lazy["']/i.test(lowerTag)) {
          tracker.iframeTagsMissingLazy += 1;
        }
      }
    }
  }

  const staticCorpus = staticParts.join('\n').toLowerCase();
  const dynamicCorpus = dynamicParts.join('\n').toLowerCase();
  const matcher = createCorpusMatcher(staticCorpus, dynamicCorpus);

  const cssFiles = files.filter((file) => {
    const kind = getAssetKind(file);
    return kind === 'css' || kind === 'css-liquid';
  });
  const entries = [];
  const warnings = [];

  for (const relativePath of cssFiles) {
    const absolutePath = path.join(sourceDir, relativePath);
    try {
      const css = await readText(absolutePath);
      commentEntries.push(
        ...collectCommentEntriesFromText(css, {
          filePath: relativePath,
          fileName: path.basename(relativePath),
          sourceType: 'css',
          sourceKey: getSourceKey(relativePath, 'comment')
        }, [
          { type: 'css-comment', regex: CSS_COMMENT_REGEX }
        ], 0, commentIndex)
      );
      commentIndex = commentEntries.length;
      tracker.cssFileCount += 1;
      tracker.cssBytes += Buffer.byteLength(css);
      tracker.cssFileStats.push({
        filePath: relativePath,
        bytes: Buffer.byteLength(css)
      });
      tracker.fontFaceCount += countMatches(css, FONT_FACE_REGEX);
      entries.push(
        ...scanCssSource(css, {
          filePath: relativePath,
          fileName: path.basename(relativePath),
          sourceType: 'css',
          sourceKey: getSourceKey(relativePath, 'css'),
          sourceLabel: absolutePath
        }, matcher)
      );
    } catch (error) {
      warnings.push({
        filePath: relativePath,
        sourceType: 'css',
        message: error?.reason || error?.message || 'Failed to parse CSS file.'
      });
    }
  }

  const markupFiles = files.filter((file) => {
    const kind = getAssetKind(file);
    return kind === 'html' || kind === 'html-liquid' || kind === 'liquid';
  });

  for (const relativePath of markupFiles) {
    const absolutePath = path.join(sourceDir, relativePath);
    try {
      const content = await readText(absolutePath);
      const scriptBlocks = extractScriptBlocks(content);
      const blocks = extractStyleBlocks(content);

      for (const block of scriptBlocks) {
        const innerOffset = block.start + block.fullMatch.indexOf(block.js);
        commentEntries.push(
          ...collectCommentEntriesFromText(block.js, {
            filePath: relativePath,
            fileName: path.basename(relativePath),
            sourceType: 'script-block',
            sourceKey: `${getSourceKey(relativePath, 'comment')}:script-block:${block.index}`
          }, [
            { type: 'js-block-comment', regex: JS_BLOCK_COMMENT_REGEX }
          ], innerOffset, commentIndex)
        );
        commentEntries.push(
          ...collectLineCommentBlocks(block.js, {
            filePath: relativePath,
            fileName: path.basename(relativePath),
            sourceType: 'script-block',
            sourceKey: `${getSourceKey(relativePath, 'comment')}:script-block:${block.index}`
          }, innerOffset, commentIndex)
        );
        commentIndex = commentEntries.length;
      }

      for (const block of blocks) {
        const innerOffset = block.start + block.fullMatch.indexOf(block.css);
        commentEntries.push(
          ...collectCommentEntriesFromText(block.css, {
            filePath: relativePath,
            fileName: path.basename(relativePath),
            sourceType: 'style-block',
            sourceKey: `${getSourceKey(relativePath, 'comment')}:style-block:${block.index}`
          }, [
            { type: 'css-comment', regex: CSS_COMMENT_REGEX }
          ], innerOffset, commentIndex)
        );
        commentIndex = commentEntries.length;
      }

      for (const block of blocks) {
        const sourceKey = getSourceKey(relativePath, 'style-block', block.index);
        try {
          entries.push(
            ...scanCssSource(block.css, {
              filePath: relativePath,
              fileName: path.basename(relativePath),
              sourceType: 'style-block',
              sourceKey,
              embeddedIndex: block.index,
              sourceLabel: `${absolutePath}::style-block:${block.index + 1}`
            }, matcher)
          );
        } catch (error) {
          warnings.push({
            filePath: relativePath,
            sourceType: 'style-block',
            embeddedIndex: block.index,
            message: error?.reason || error?.message || 'Failed to parse embedded CSS.'
          });
        }
      }
    } catch (error) {
      warnings.push({
        filePath: relativePath,
        sourceType: 'markup',
        message: error?.message || 'Failed to read markup file.'
      });
    }
  }

  const totalRules = entries.length;
  const usedRules = entries.filter((entry) => entry.status === 'used').length;
  const unusedRules = totalRules - usedRules;
  const estimatedSavingsBytes = entries
    .filter((entry) => entry.status === 'unused')
    .reduce((sum, entry) => sum + entry.estimatedBytes, 0);
  const unusedCssFiles = cssFiles
    .map((relativePath) => {
      const absolutePath = path.join(sourceDir, relativePath);
      return {
        filePath: relativePath,
        fileName: path.basename(relativePath),
        bytes: tracker.cssFileStats.find((item) => item.filePath === relativePath)?.bytes || 0,
        referenced: isFileReferencedInCorpus(relativePath, matcher),
        absolutePath
      };
    })
    .filter((entry) => !entry.referenced)
    .map(({ absolutePath, referenced, ...entry }) => entry);

  const jsFiles = textFiles.filter((file) => {
    const kind = getAssetKind(file);
    return kind === 'js' || kind === 'js-liquid';
  });
  const unusedJsFiles = jsFiles
    .map((relativePath) => ({
      filePath: relativePath,
      fileName: path.basename(relativePath),
      bytes: tracker.jsFileStats.find((item) => item.filePath === relativePath)?.bytes || 0,
      referenced: isFileReferencedInCorpus(relativePath, matcher)
    }))
    .filter((entry) => !entry.referenced)
    .map(({ referenced, ...entry }) => entry);

  return {
    createdAt: new Date().toISOString(),
    sourceDir,
    cssFiles,
    textFiles,
    summary: {
      totalRules,
      usedRules,
      unusedRules,
      estimatedSavingsBytes
    },
    tailwindDetected: tracker.tailwindDetected,
    tailwindEvidence: tracker.tailwindEvidence,
    entries,
    commentEntries,
    warnings,
    performance: {
      summary: {
        cssFileCount: tracker.cssFileCount,
        cssBytes: tracker.cssBytes,
        jsFileCount: textFiles.filter((file) => path.extname(file).toLowerCase() === '.js').length,
        markupFileCount: tracker.markupFileCount,
        imageTags: tracker.imageTags,
        imageTagsMissingDimensions: tracker.imageTagsMissingDimensions,
        imageTagsMissingLazy: tracker.imageTagsMissingLazy,
        iframeTags: tracker.iframeTags,
        iframeTagsMissingLazy: tracker.iframeTagsMissingLazy,
        stylesheetLinks: tracker.stylesheetLinks,
        scriptSrcTags: tracker.scriptSrcTags,
        inlineStyleAttributes: tracker.inlineStyleAttributes,
        fontFaceCount: tracker.fontFaceCount,
        tailwindDetected: tracker.tailwindDetected
      },
      unusedCssFiles,
      unusedJsFiles,
      imagesMissingDimensions: tracker.imagesMissingDimensions,
      imagesMissingLazy: tracker.imagesMissingLazy,
      tailwindDetected: tracker.tailwindDetected,
      tailwindEvidence: tracker.tailwindEvidence,
      recommendations: buildPerformanceRecommendations({
        entries,
        summary: {
          totalRules,
          usedRules,
          unusedRules,
          estimatedSavingsBytes
        },
        performance: {
          unusedCssFiles,
          unusedJsFiles
        }
      }, tracker)
    }
  };
}

export async function writeReport(reportPath, report) {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

export async function readReport(reportPath) {
  const raw = await fs.readFile(reportPath, 'utf8');
  return JSON.parse(raw);
}

export async function removeSelectedSelectors(workspaceDir, selectedIds, selectedCommentIds, report, protectedPatterns = [], options = {}) {
  const ignoreSmallComments = Boolean(options.ignoreSmallComments);
  const smallCommentMaxLines = Number.isFinite(options.smallCommentMaxLines) ? options.smallCommentMaxLines : 2;
  const ignoreLiquidDocComments = Boolean(options.ignoreLiquidDocComments);
  const selectedSet = new Set(selectedIds);
  const selectedCommentSet = new Set(selectedCommentIds);
  const normalizedProtectedPatterns = normalizeProtectedPatterns(protectedPatterns);
  const validIds = new Set();
  const cssEntriesByFile = new Map();
  const styleBlockEntriesByFile = new Map();
  const selectedFiles = new Set();
  const selectedCommentEntriesByFile = new Map();

  for (const entry of report.entries || []) {
    if (entry.status === 'unused') {
      validIds.add(entry.id);
    }

    if (entry.sourceType === 'css') {
      if (!cssEntriesByFile.has(entry.filePath)) {
        cssEntriesByFile.set(entry.filePath, []);
      }
      cssEntriesByFile.get(entry.filePath).push(entry);
    } else if (entry.sourceType === 'style-block') {
      if (!styleBlockEntriesByFile.has(entry.filePath)) {
        styleBlockEntriesByFile.set(entry.filePath, []);
      }
      styleBlockEntriesByFile.get(entry.filePath).push(entry);
    }
  }

  const validCommentIds = new Set();
  for (const entry of report.commentEntries || []) {
    validCommentIds.add(entry.id);
  }

  for (const id of selectedSet) {
    if (!validIds.has(id)) {
      throw new Error(`Selector ${id} is not available for removal.`);
    }
  }

  for (const id of selectedCommentSet) {
    if (!validCommentIds.has(id)) {
      throw new Error(`Comment ${id} is not available for removal.`);
    }
  }

  if (selectedSet.size === 0 && selectedCommentSet.size === 0) {
    throw new Error('Please select at least one unused selector or comment to remove.');
  }

  for (const entry of report.entries || []) {
    if (selectedSet.has(entry.id)) {
      selectedFiles.add(entry.filePath);
    }
  }

  for (const entry of report.commentEntries || []) {
    if (selectedCommentSet.has(entry.id)) {
      selectedFiles.add(entry.filePath);
      if (!selectedCommentEntriesByFile.has(entry.filePath)) {
        selectedCommentEntriesByFile.set(entry.filePath, []);
      }
      selectedCommentEntriesByFile.get(entry.filePath).push(entry);
    }
  }

  let removedSelectors = 0;
  let removedComments = 0;
  let protectedSelectorsSkipped = 0;
  const changedFiles = [];

  for (const relativePath of selectedFiles) {
    const inputPath = path.join(workspaceDir, relativePath);
    const outputPath = path.join(workspaceDir, relativePath);
    let content = await readText(inputPath);
    const selectedCommentRanges = (selectedCommentEntriesByFile.get(relativePath) || [])
      .filter((entry) => {
        if (ignoreLiquidDocComments && entry.isLiquidDoc) return false;
        if (ignoreSmallComments && isSmallCommentEntry(entry, smallCommentMaxLines)) return false;
        return true;
      });
    if (selectedCommentRanges.length > 0) {
      removedComments += selectedCommentRanges.length;
      content = removeCommentEntriesFromText(content, selectedCommentRanges);
    }

    const assetKind = getAssetKind(relativePath);
    if (assetKind === 'js' || assetKind === 'js-liquid') {
      await fs.writeFile(outputPath, content, 'utf8');
      changedFiles.push({
        relativePath,
        contentBase64: Buffer.from(content, 'utf8').toString('base64')
      });
      continue;
    }

    if (assetKind === 'css' || assetKind === 'css-liquid') {
      const root = postcss.parse(content, { from: inputPath });
      const entriesForFile = cssEntriesByFile.get(relativePath) || [];
      const ruleLookup = new Map();

      for (const entry of entriesForFile) {
        if (!ruleLookup.has(entry.ruleIndex)) {
          ruleLookup.set(entry.ruleIndex, []);
        }
        ruleLookup.get(entry.ruleIndex).push(entry);
      }

      let currentRuleIndex = 0;
      root.walkRules((rule) => {
        const entriesForRule = ruleLookup.get(currentRuleIndex) || [];
        if (entriesForRule.length > 0) {
          const selectors = Array.isArray(rule.selectors) ? rule.selectors : [rule.selector];
          const filteredSelectors = selectors.filter((selector, selectorIndex) => {
            const entry = entriesForRule.find((item) => item.selector === selector && item.selectorIndex === selectorIndex);
            if (entry && selectedSet.has(entry.id) && !selectorMatchesProtected(selector, normalizedProtectedPatterns)) {
              removedSelectors += 1;
              return false;
            }
            if (entry && selectedSet.has(entry.id) && selectorMatchesProtected(selector, normalizedProtectedPatterns)) {
              protectedSelectorsSkipped += 1;
            }
            return true;
          });

          if (filteredSelectors.length === 0) {
            rule.remove();
          } else if (filteredSelectors.length !== selectors.length) {
            rule.selector = filteredSelectors.join(', ');
          }
        }

        currentRuleIndex += 1;
      });

      const updatedCss = root.toString();
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, updatedCss, 'utf8');
      changedFiles.push({
        relativePath,
        contentBase64: Buffer.from(updatedCss, 'utf8').toString('base64')
      });
      continue;
    }

    if (assetKind === 'html' || assetKind === 'html-liquid' || assetKind === 'liquid') {
      const entriesForFile = styleBlockEntriesByFile.get(relativePath) || [];
      const blockEntriesMap = new Map();

      for (const entry of entriesForFile) {
        if (!blockEntriesMap.has(entry.embeddedIndex)) {
          blockEntriesMap.set(entry.embeddedIndex, []);
        }
        blockEntriesMap.get(entry.embeddedIndex).push(entry);
      }

      let blockIndex = 0;
      const updated = content.replace(STYLE_BLOCK_REGEX, (fullMatch, cssInner) => {
        const entriesForBlock = blockEntriesMap.get(blockIndex) || [];
        blockIndex += 1;
        const hasLiquidSyntax = /({{[\s\S]*?}}|{%\s*[\s\S]*?%})/.test(cssInner);
        if (entriesForBlock.length === 0 || hasLiquidSyntax) {
          return fullMatch;
        }

        const root = postcss.parse(cssInner, { from: `${inputPath}::style-block:${blockIndex}` });
        const ruleLookup = new Map();

        for (const entry of entriesForBlock) {
          if (!ruleLookup.has(entry.ruleIndex)) {
            ruleLookup.set(entry.ruleIndex, []);
          }
          ruleLookup.get(entry.ruleIndex).push(entry);
        }

        let currentRuleIndex = 0;
        root.walkRules((rule) => {
          const entriesForRule = ruleLookup.get(currentRuleIndex) || [];
          if (entriesForRule.length > 0) {
            const selectors = Array.isArray(rule.selectors) ? rule.selectors : [rule.selector];
            const filteredSelectors = selectors.filter((selector, selectorIndex) => {
              const entry = entriesForRule.find((item) => item.selector === selector && item.selectorIndex === selectorIndex);
              if (entry && selectedSet.has(entry.id) && !selectorMatchesProtected(selector, normalizedProtectedPatterns)) {
                removedSelectors += 1;
                return false;
              }
              if (entry && selectedSet.has(entry.id) && selectorMatchesProtected(selector, normalizedProtectedPatterns)) {
                protectedSelectorsSkipped += 1;
              }
              return true;
            });

            if (filteredSelectors.length === 0) {
              rule.remove();
            } else if (filteredSelectors.length !== selectors.length) {
              rule.selector = filteredSelectors.join(', ');
            }
          }

          currentRuleIndex += 1;
        });

        return fullMatch.replace(cssInner, root.toString());
      });

      await fs.writeFile(inputPath, updated, 'utf8');
      changedFiles.push({
        relativePath,
        contentBase64: Buffer.from(updated, 'utf8').toString('base64')
      });
    }
  }

  return {
    workspaceDir,
    removedSelectors,
    removedComments,
    protectedSelectorsSkipped,
    changedFiles
  };
}
