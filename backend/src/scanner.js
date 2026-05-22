import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

const TEXT_EXTENSIONS = new Set(['.liquid', '.html', '.js']);
const STYLE_BLOCK_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

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
    warnings
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
