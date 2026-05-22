import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

const TEXT_EXTENSIONS = new Set(['.liquid', '.html', '.js']);
const STYLE_BLOCK_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const IMG_TAG_REGEX = /<img\b[^>]*>/gi;
const IFRAME_TAG_REGEX = /<iframe\b[^>]*>/gi;
const LINK_STYLESHEET_REGEX = /<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi;
const SCRIPT_SRC_REGEX = /<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi;
const INLINE_STYLE_REGEX = /\sstyle=["'][^"']*["']/gi;
const FONT_FACE_REGEX = /@font-face\b/gi;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  if (!Array.isArray(patterns)) return [];
  return patterns
    .map((pattern) => String(pattern || '').trim())
    .filter(Boolean);
}

function selectorMatchesProtected(selector, protectedPatterns) {
  const normalizedSelector = String(selector || '');
  if (!normalizedSelector || protectedPatterns.length === 0) return false;

  for (const rawPattern of protectedPatterns) {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) continue;

    if (normalizedSelector.includes(pattern)) {
      return true;
    }

    const barePattern = pattern.replace(/^[.#\s]+/, '');
    if (!barePattern) continue;

    const boundary = buildBoundaryPattern(barePattern);
    if (boundary.test(normalizedSelector)) {
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

function hasAttribute(tag, attributeName) {
  const attributePattern = new RegExp(`\\b${escapeRegExp(attributeName)}\\s*=`, 'i');
  return attributePattern.test(tag);
}

function countMatches(source, regex) {
  const matches = String(source || '').match(regex);
  return matches ? matches.length : 0;
}

function createPerformanceTracker() {
  return {
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
    cssFileStats: []
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

  return recommendations;
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

  for (const relativePath of textFiles) {
    const absolutePath = path.join(sourceDir, relativePath);
    const content = await readText(absolutePath);
    const ext = path.extname(relativePath).toLowerCase();

    if (ext === '.liquid') {
      staticParts.push(stripStyleBlocks(stripLiquidTags(content)));
      dynamicParts.push(extractLiquidDynamic(content));
    } else {
      staticParts.push(stripStyleBlocks(content));
    }

    if (ext === '.liquid' || ext === '.html') {
      tracker.markupFileCount += 1;
      tracker.imageTags += countMatches(content, IMG_TAG_REGEX);
      tracker.iframeTags += countMatches(content, IFRAME_TAG_REGEX);
      tracker.stylesheetLinks += countMatches(content, LINK_STYLESHEET_REGEX);
      tracker.scriptSrcTags += countMatches(content, SCRIPT_SRC_REGEX);
      tracker.inlineStyleAttributes += countMatches(content, INLINE_STYLE_REGEX);

      for (const tag of String(content || '').match(IMG_TAG_REGEX) || []) {
        const lowerTag = tag.toLowerCase();
        if (!hasAttribute(tag, 'width') || !hasAttribute(tag, 'height')) {
          tracker.imageTagsMissingDimensions += 1;
        }
        if (!/loading\s*=\s*["']lazy["']/i.test(lowerTag)) {
          tracker.imageTagsMissingLazy += 1;
        }
      }

      for (const tag of String(content || '').match(IFRAME_TAG_REGEX) || []) {
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

  const cssFiles = files.filter((file) => path.extname(file).toLowerCase() === '.css');
  const entries = [];
  const warnings = [];

  for (const relativePath of cssFiles) {
    const absolutePath = path.join(sourceDir, relativePath);
    try {
      const css = await readText(absolutePath);
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

  const markupFiles = files.filter((file) => ['.liquid', '.html'].includes(path.extname(file).toLowerCase()));

  for (const relativePath of markupFiles) {
    const absolutePath = path.join(sourceDir, relativePath);
    try {
      const content = await readText(absolutePath);
      const blocks = extractStyleBlocks(content);

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
    entries,
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
        fontFaceCount: tracker.fontFaceCount
      },
      unusedCssFiles,
      recommendations: buildPerformanceRecommendations({
        entries,
        summary: {
          totalRules,
          usedRules,
          unusedRules,
          estimatedSavingsBytes
        },
        performance: {
          unusedCssFiles
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

export async function removeSelectedSelectors(workspaceDir, selectedIds, report, protectedPatterns = []) {
  const selectedSet = new Set(selectedIds);
  const normalizedProtectedPatterns = normalizeProtectedPatterns(protectedPatterns);
  const validIds = new Set(
    report.entries
      .filter((entry) => entry.status === 'unused')
      .map((entry) => entry.id)
  );

  for (const id of selectedSet) {
    if (!validIds.has(id)) {
      throw new Error(`Selector ${id} is not available for removal.`);
    }
  }

  const cssFiles = await fg(['**/*.css'], {
    cwd: workspaceDir,
    onlyFiles: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/backups/**', '**/uploads/**', '**/cleaned/**']
  });

  let removedSelectors = 0;
  let protectedSelectorsSkipped = 0;

  for (const relativePath of cssFiles) {
    const inputPath = path.join(workspaceDir, relativePath);
    const outputPath = path.join(workspaceDir, relativePath);
    const css = await readText(inputPath);
    const root = postcss.parse(css, { from: inputPath });
    const entriesForFile = report.entries.filter((entry) => entry.filePath === relativePath && entry.sourceType === 'css');
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

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, root.toString(), 'utf8');
  }

  const markupFiles = await fg(['**/*.{liquid,html}'], {
    cwd: workspaceDir,
    onlyFiles: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/backups/**', '**/uploads/**', '**/cleaned/**']
  });

  for (const relativePath of markupFiles) {
    const inputPath = path.join(workspaceDir, relativePath);
    const original = await readText(inputPath);
    const entriesForFile = report.entries.filter(
      (entry) => entry.filePath === relativePath && entry.sourceType === 'style-block'
    );
    const blockEntriesMap = new Map();

    for (const entry of entriesForFile) {
      if (!blockEntriesMap.has(entry.embeddedIndex)) {
        blockEntriesMap.set(entry.embeddedIndex, []);
      }
      blockEntriesMap.get(entry.embeddedIndex).push(entry);
    }

    let blockIndex = 0;
    const updated = original.replace(STYLE_BLOCK_REGEX, (fullMatch, cssInner) => {
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
  }

  return {
    workspaceDir,
    removedSelectors,
    protectedSelectorsSkipped
  };
}
