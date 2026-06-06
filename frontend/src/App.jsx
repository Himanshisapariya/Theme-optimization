import React, { useMemo, useRef, useState } from 'react';

const initialSummary = {
  totalRules: 0,
  usedRules: 0,
  unusedRules: 0,
  estimatedSavingsBytes: 0
};

const PROTECTED_PRESETS_STORAGE_KEY = 'css-analyser-protected-presets-v1';

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function filenameFromDisposition(disposition, fallback) {
  if (!disposition) return fallback;
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  return match ? match[1] : fallback;
}

function groupEntriesByFile(entries) {
  return entries.reduce((grouped, entry) => {
    if (!grouped.has(entry.filePath)) {
      grouped.set(entry.filePath, []);
    }
    grouped.get(entry.filePath).push(entry);
    return grouped;
  }, new Map());
}

function selectorMatchesProtected(selector, patterns) {
  const normalizedSelector = String(selector || '');
  if (!normalizedSelector) return false;

  return patterns.some((rawPattern) => {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) return false;
    if (normalizedSelector.includes(pattern)) return true;

    const barePattern = pattern.replace(/^[.#\s]+/, '');
    if (!barePattern) return false;

    return normalizedSelector.includes(barePattern);
  });
}

function readProtectedPresets() {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(PROTECTED_PRESETS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.presets)
        ? parsed.presets
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [];

    return items
      .map((item) => {
        const name = String(item?.name || item?.presetName || item?.label || '').trim();
        const rawPatterns = Array.isArray(item?.patterns)
          ? item.patterns
          : Array.isArray(item?.selectors)
            ? item.selectors
            : Array.isArray(item?.protectedSelectors)
              ? item.protectedSelectors
              : Array.isArray(item?.values)
                ? item.values
                : Array.isArray(item?.items)
                  ? item.items
                  : [];

        return {
          name,
          patterns: rawPatterns.map((pattern) => String(pattern || '').trim()).filter(Boolean)
        };
      })
      .filter((item) => item.name && item.patterns.length > 0);
  } catch (error) {
    return [];
  }
}

function normalizeProtectedSelectors(values) {
  if (!Array.isArray(values)) return [];

  return [...new Set(
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function readSavedProtectedPresets() {
  return readProtectedPresets();
}

function findSavedProtectedPreset(name) {
  const target = String(name || '').trim();
  if (!target) return null;
  return readProtectedPresets().find((item) => item.name === target) || null;
}

function writeSavedProtectedPresets(nextPresets) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(PROTECTED_PRESETS_STORAGE_KEY, JSON.stringify(nextPresets));
  }
}

const IGNORED_UPLOAD_BASENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'HEAD',
  'config',
  'description',
  'index',
  'packed-refs',
  'FETCH_HEAD'
]);

function isIgnorableUploadPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const baseName = normalized.split('/').pop();
  return (
    !normalized ||
    normalized.startsWith('__MACOSX/') ||
    normalized.includes('/__MACOSX/') ||
    normalized.startsWith('.git/') ||
    normalized.includes('/.git/') ||
    normalized.startsWith('.') ||
    IGNORED_UPLOAD_BASENAMES.has(baseName)
  );
}

function normalizeUploadItem(file, relativePath) {
  return {
    file,
    relativePath: relativePath || file.webkitRelativePath || file.name
  };
}

function stripCommonRootFolder(uploaded) {
  const normalized = uploaded
    .map((item) => ({
      ...item,
      relativePath: String(item.relativePath || item.file?.name || '').replace(/\\/g, '/')
    }))
    .filter((item) => item.relativePath);

  if (normalized.length <= 1) {
    return normalized;
  }

  const firstSegments = normalized.map((item) => item.relativePath.split('/').filter(Boolean)[0]).filter(Boolean);
  const rootName = firstSegments[0];
  const hasSharedRoot = rootName && firstSegments.every((segment) => segment === rootName) && normalized.some((item) => item.relativePath.includes('/'));

  if (!hasSharedRoot) {
    return normalized;
  }

  return normalized.map((item) => {
    const prefix = `${rootName}/`;
    const relativePath = item.relativePath.startsWith(prefix)
      ? item.relativePath.slice(prefix.length)
      : item.relativePath;
    return {
      ...item,
      relativePath: relativePath || item.file?.name || item.relativePath
    };
  });
}

async function readAllEntries(reader) {
  const entries = [];
  // Chrome returns directory entries in batches, so keep reading until empty.
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

async function collectDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  const supportsEntries = items.some((item) => typeof item.webkitGetAsEntry === 'function');

  if (!supportsEntries) {
    return Array.from(dataTransfer.files || []).map((file) => normalizeUploadItem(file));
  }

  const dropped = [];

  async function walkEntry(entry, prefix = '') {
    if (entry.isFile) {
      await new Promise((resolve, reject) => {
        entry.file((file) => {
          dropped.push(normalizeUploadItem(file, `${prefix}${entry.name}`));
          resolve();
        }, reject);
      });
      return;
    }

    if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readAllEntries(reader);
      for (const child of children) {
        // eslint-disable-next-line no-await-in-loop
        await walkEntry(child, `${prefix}${entry.name}/`);
      }
    }
  }

  for (const item of items) {
    const entry = item.webkitGetAsEntry();
    if (entry) {
      // eslint-disable-next-line no-await-in-loop
      await walkEntry(entry);
    }
  }

  return dropped;
}

function base64ToUint8Array(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function candidateHandleKeys(relativePath, folderName = '') {
  const normalized = normalizeRelativePath(relativePath);
  const candidates = new Set();

  if (!normalized) return [];

  candidates.add(normalized);

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length > 1) {
    candidates.add(parts.slice(1).join('/'));
  }

  if (folderName) {
    const prefix = `${normalizeRelativePath(folderName)}/`;
    if (normalized.startsWith(prefix)) {
      candidates.add(normalized.slice(prefix.length));
    }
  }

  if (parts.length > 2) {
    candidates.add(parts.slice(2).join('/'));
  }

  return [...candidates].filter(Boolean);
}

function buildHandleLookup(uploaded) {
  const lookup = new Map();

  for (const { relativePath, handle } of uploaded) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || !handle) continue;

    const parts = normalized.split('/').filter(Boolean);
    const suffixes = [];

    for (let index = 0; index < parts.length; index += 1) {
      suffixes.push(parts.slice(index).join('/'));
    }

    for (const key of suffixes) {
      const existing = lookup.get(key);
      if (existing) {
        existing.add(handle);
      } else {
        lookup.set(key, new Set([handle]));
      }
    }
  }

  return lookup;
}

async function ensureWritePermission(handle) {
  if (!handle) return false;

  try {
    if (typeof handle.queryPermission === 'function') {
      const current = await handle.queryPermission({ mode: 'readwrite' });
      if (current === 'granted') return true;
    }

    if (typeof handle.requestPermission === 'function') {
      const next = await handle.requestPermission({ mode: 'readwrite' });
      return next === 'granted';
    }
  } catch (error) {
    return false;
  }

  return false;
}

async function writeFilesToHandleMap(handleMap, files, folderName = '') {
  let written = 0;
  let failed = 0;
  let firstError = '';

  for (const file of files) {
    const candidates = candidateHandleKeys(file.relativePath, folderName);
    let handle = null;

    for (const candidate of candidates) {
      const matches = handleMap.get(candidate);
      if (matches && matches.size === 1) {
        handle = [...matches][0];
        break;
      }
    }

    if (!handle) {
      continue;
    }

    try {
      const canWrite = await ensureWritePermission(handle);
      if (!canWrite) {
        throw new Error('Write permission not granted for this file');
      }
      const writable = await handle.createWritable();
      await writable.write(base64ToUint8Array(file.contentBase64));
      await writable.close();
      written++;
    } catch (err) {
      failed++;
      if (!firstError) firstError = err?.message || 'Write failed';
      console.warn('[CSS Analyser] skip', file.relativePath, err?.message);
    }
  }

  return { written, failed, firstError };
}

const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '__MACOSX']);

async function collectFilesFromDirectoryHandle(dirHandle, prefix = '') {
  const items = [];
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind === 'directory') {
      if (IGNORED_DIR_NAMES.has(name) || name.startsWith('.')) continue;
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const subItems = await collectFilesFromDirectoryHandle(entry, relativePath);
      items.push(...subItems);
    } else {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const file = await entry.getFile();
      items.push({ file, relativePath, handle: entry });
    }
  }
  return items;
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [jobId, setJobId] = useState('');
  const [summary, setSummary] = useState(initialSummary);
  const [entries, setEntries] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [message, setMessage] = useState('Upload a Shopify theme folder or ZIP to begin.');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('idle');
  const [dropActive, setDropActive] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [scanWarnings, setScanWarnings] = useState([]);
  const [performanceReport, setPerformanceReport] = useState(null);
  const [reportTab, setReportTab] = useState('css');
  const [commentEntries, setCommentEntries] = useState([]);
  const fileHandlesRef = useRef(new Map());
  const rootDirHandleRef = useRef(null);
  const localFilePathsRef = useRef(new Map());
  const folderInputRef = useRef(null);
  const [localFolderName, setLocalFolderName] = useState('');
  const [localFolderMode, setLocalFolderMode] = useState('none');
  const [protectedSelectorsText, setProtectedSelectorsText] = useState('');
  const [protectedSelectors, setProtectedSelectors] = useState([]);
  const [ignoredFilter, setIgnoredFilter] = useState('');
  const [presetName, setPresetName] = useState('');
  const [savedProtectedPresets, setSavedProtectedPresets] = useState(() => readProtectedPresets());
  const [activePresetName, setActivePresetName] = useState('');
  const protectedPresetsHydratedRef = useRef(false);
  const [selectedCommentIds, setSelectedCommentIds] = useState(new Set());
  const [ignoreShortComments, setIgnoreShortComments] = useState(false);
  const [ignoreLiquidDocComments, setIgnoreLiquidDocComments] = useState(true);
  const [selectorTab, setSelectorTab] = useState('css');
  const [selectedUnusedCssFiles, setSelectedUnusedCssFiles] = useState(new Set());
  const [selectedUnusedJsFiles, setSelectedUnusedJsFiles] = useState(new Set());
  const [expandedRecommendations, setExpandedRecommendations] = useState(new Set());
  const [lastCssRemoval, setLastCssRemoval] = useState(null);
  const [lastCommentRemoval, setLastCommentRemoval] = useState(null);
  const [hasCleanupChanges, setHasCleanupChanges] = useState(false);
  const shortCommentMaxLines = 2;

  const protectedPatterns = useMemo(
    () => protectedSelectors,
    [protectedSelectors]
  );
  const unusedEntries = useMemo(() => entries.filter((entry) => entry.status === 'unused'), [entries]);
  const ignoredUnusedEntries = useMemo(
    () => unusedEntries.filter((entry) => selectorMatchesProtected(entry.selector, protectedPatterns)),
    [unusedEntries, protectedPatterns]
  );
  const filteredIgnoredUnusedEntries = useMemo(() => {
    const query = ignoredFilter.trim().toLowerCase();
    if (!query) return ignoredUnusedEntries;

    return ignoredUnusedEntries.filter((entry) => {
      const selector = String(entry.selector || '').toLowerCase();
      const fileName = String(entry.fileName || '').toLowerCase();
      const filePath = String(entry.filePath || '').toLowerCase();
      return selector.includes(query) || fileName.includes(query) || filePath.includes(query);
    });
  }, [ignoredFilter, ignoredUnusedEntries]);
  const removableUnusedEntries = useMemo(
    () => unusedEntries.filter((entry) => !selectorMatchesProtected(entry.selector, protectedPatterns)),
    [unusedEntries, protectedPatterns]
  );
  const selectedIdsForRemoval = useMemo(() => {
    const protectedIds = new Set(ignoredUnusedEntries.map((entry) => entry.id));
    return new Set(Array.from(selectedIds).filter((id) => !protectedIds.has(id)));
  }, [selectedIds, ignoredUnusedEntries]);
  const commentEntriesById = useMemo(
    () => new Map(commentEntries.map((entry) => [entry.id, entry])),
    [commentEntries]
  );
  const selectedCommentIdsForRemoval = useMemo(() => {
    const ids = Array.from(selectedCommentIds);
    return ids.filter((id) => {
      const entry = commentEntriesById.get(id);
      if (!entry) return false;
      if (ignoreLiquidDocComments && entry.isLiquidDoc) return false;
      if (ignoreShortComments && Number(entry.lineCount || 0) <= shortCommentMaxLines) return false;
      return true;
    });
  }, [selectedCommentIds, ignoreShortComments, ignoreLiquidDocComments, commentEntriesById]);

  const ignoredShortCommentEntries = useMemo(() => {
    return commentEntries.filter((entry) => {
      if (ignoreLiquidDocComments && entry.isLiquidDoc) return false;
      return ignoreShortComments && Number(entry?.lineCount || 0) > 0 && Number(entry.lineCount) <= shortCommentMaxLines;
    });
  }, [commentEntries, ignoreShortComments, ignoreLiquidDocComments]);

  const ignoredLiquidDocEntries = useMemo(() => {
    if (!ignoreLiquidDocComments) return [];
    return commentEntries.filter((entry) => entry.isLiquidDoc);
  }, [commentEntries, ignoreLiquidDocComments]);

  const removableCommentEntries = useMemo(() => {
    return commentEntries.filter((entry) => {
      if (ignoreLiquidDocComments && entry.isLiquidDoc) return false;
      if (ignoreShortComments && Number(entry?.lineCount || 0) <= shortCommentMaxLines) return false;
      return true;
    });
  }, [commentEntries, ignoreShortComments, ignoreLiquidDocComments]);
  const protectedSelectorDraft = useMemo(
    () => normalizeProtectedSelectors([...protectedSelectors, ...parseProtectedSelectors(protectedSelectorsText)]),
    [protectedSelectors, protectedSelectorsText]
  );
  function clearResults() {
    setSummary(initialSummary);
    setEntries([]);
    setSelectedIds(new Set());
    setCommentEntries([]);
    setSelectedCommentIds(new Set());
    setSelectedUnusedCssFiles(new Set());
    setSelectedUnusedJsFiles(new Set());
    setExpandedRecommendations(new Set());
    setScanWarnings([]);
    setPerformanceReport(null);
    setReportTab('css');
    setLastCssRemoval(null);
    setLastCommentRemoval(null);
    setHasCleanupChanges(false);
  }

  function parseProtectedSelectors(text) {
    return String(text || '')
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function addProtectedSelectors() {
    const nextValues = parseProtectedSelectors(protectedSelectorsText);
    if (nextValues.length === 0) return;

    setProtectedSelectors((current) => normalizeProtectedSelectors([...current, ...nextValues]));
    setProtectedSelectorsText('');
    setMessage(`Added ${nextValues.length} protected selector(s).`);
  }

  function clearProtectedSelectors() {
    setProtectedSelectors([]);
    setProtectedSelectorsText('');
    setActivePresetName('');
  }

  function removeProtectedSelector(value) {
    setProtectedSelectors((current) => current.filter((item) => item !== value));
  }

  function saveProtectedPreset() {
    const name = presetName.trim();
    const nextProtectedSelectors = protectedSelectorDraft;
    if (!name || nextProtectedSelectors.length === 0) return;

    setProtectedSelectors(nextProtectedSelectors);
    setProtectedSelectorsText('');
    setSavedProtectedPresets((current) => {
      const next = [
        { name, patterns: [...nextProtectedSelectors] },
        ...current.filter((preset) => preset.name !== name)
      ];
      writeSavedProtectedPresets(next);
      return next;
    });
    setActivePresetName(name);
    setMessage(`Saved protected preset "${name}".`);
  }

  function loadProtectedPreset(name) {
    const preset = findSavedProtectedPreset(name);
    if (!preset) return;

    setProtectedSelectors([...preset.patterns]);
    setPresetName(preset.name);
    setActivePresetName(preset.name);
    setProtectedSelectorsText('');
    setSavedProtectedPresets(readSavedProtectedPresets());
    setMessage(`Loaded protected preset "${preset.name}".`);
  }

  function deleteProtectedPreset(name) {
    setSavedProtectedPresets((current) => {
      const next = current.filter((preset) => preset.name !== name);
      writeSavedProtectedPresets(next);
      return next;
    });

    if (activePresetName === name) {
      setActivePresetName('');
    }
    setMessage(`Deleted protected preset "${name}".`);
  }

  function refreshProtectedPresets() {
    const next = readSavedProtectedPresets();
    setSavedProtectedPresets(next);
    setMessage(next.length > 0
      ? `Loaded ${next.length} saved protected preset(s).`
      : 'No saved protected presets were found.');
  }

  React.useEffect(() => {
    if (entries.length === 0) return;

    setSelectedIds((current) => {
      const next = new Set(current);
      for (const entry of ignoredUnusedEntries) {
        next.delete(entry.id);
      }
      return next;
    });
  }, [entries, ignoredUnusedEntries]);

  React.useEffect(() => {
    if (selectedIds.size === 0) return;

    setSelectedIds((current) => {
      const next = new Set(current);
      for (const entry of ignoredUnusedEntries) {
        next.delete(entry.id);
      }
      return next;
    });
  }, [ignoredUnusedEntries]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!protectedPresetsHydratedRef.current) {
      protectedPresetsHydratedRef.current = true;
      return;
    }
    window.localStorage.setItem(PROTECTED_PRESETS_STORAGE_KEY, JSON.stringify(savedProtectedPresets));
  }, [savedProtectedPresets]);

  React.useEffect(() => {
    setSavedProtectedPresets(readSavedProtectedPresets());
  }, []);

  React.useEffect(() => {
    function handleStorageChange(event) {
      if (event.key === PROTECTED_PRESETS_STORAGE_KEY) {
        setSavedProtectedPresets(readProtectedPresets());
      }
    }

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  React.useEffect(() => {
    if (commentEntries.length === 0) return;

    setSelectedCommentIds((current) => {
      const next = new Set(current);
      for (const entry of commentEntries) {
        next.add(entry.id);
      }
      return next;
    });
  }, [commentEntries]);

  async function uploadFiles(uploaded, { skipStrip = false } = {}) {
    const processed = skipStrip
      ? uploaded.map((item) => ({ ...item, relativePath: String(item.relativePath || item.file?.name || '').replace(/\\/g, '/') })).filter((item) => item.relativePath)
      : stripCommonRootFolder(uploaded);
    const filtered = processed.filter(({ relativePath, file }) => !isIgnorableUploadPath(relativePath || file.name));
    setFiles(filtered);
    if (filtered.length === 0) {
      setMessage('Only ignored system files were selected. Please upload the actual theme files or folder.');
      return;
    }

    const formData = new FormData();
    filtered.forEach(({ file, relativePath }) => {
      formData.append('files', file, relativePath);
    });

    setLoading(true);
    setStep('uploading');
    setMessage('Uploading files...');

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed.');

      setJobId(data.jobId);
      clearResults();
      setMessage(data.message);
      setStep('uploaded');
    } catch (error) {
      setMessage(error.message);
      setStep('idle');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(event) {
    setLocalFolderName('');
    setLocalFolderMode('none');
    fileHandlesRef.current = new Map();
    rootDirHandleRef.current = null;
    localFilePathsRef.current = new Map();
    const uploaded = Array.from(event.target.files || []).map((file) => normalizeUploadItem(file));
    await uploadFiles(uploaded);
    event.target.value = '';
    setInputKey((current) => current + 1);
  }

  async function handleFolderButtonClick() {
    if (window.showDirectoryPicker) {
      try {
        // mode:'readwrite' grants write access as part of the picker
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const uploaded = await collectFilesFromDirectoryHandle(handle);
        fileHandlesRef.current = buildHandleLookup(uploaded);
        rootDirHandleRef.current = handle;

        // Build suffix → full path map so local deletion can resolve flat server paths
        // back to their real subdirectory locations (e.g. "foo.css" → "assets/foo.css").
        const pathLookup = new Map();
        for (const { relativePath } of uploaded) {
          const normalized = normalizeRelativePath(relativePath);
          const parts = normalized.split('/').filter(Boolean);
          for (let i = 0; i < parts.length; i++) {
            const suffix = parts.slice(i).join('/');
            if (!pathLookup.has(suffix)) {
              pathLookup.set(suffix, normalized);
            }
          }
        }
        localFilePathsRef.current = pathLookup;

        // skipStrip: paths from collectFilesFromDirectoryHandle are already relative to handle root
        await uploadFiles(uploaded, { skipStrip: true });
        setLocalFolderName(handle.name || 'Selected folder');
        setLocalFolderMode('handle');
      } catch (error) {
        if (error?.name !== 'AbortError') {
          setMessage(error.message || 'Unable to select a folder.');
        }
      }
    } else {
      folderInputRef.current?.click();
    }
  }

  async function handleFolderInputChange(event) {
    setLocalFolderName('');
    setLocalFolderMode('none');
    fileHandlesRef.current = new Map();
    rootDirHandleRef.current = null;
    localFilePathsRef.current = new Map();
    const uploaded = Array.from(event.target.files || []).map((file) =>
      normalizeUploadItem(file, file.webkitRelativePath || file.name)
    );
    await uploadFiles(uploaded);
    event.target.value = '';
  }

  async function handleDrop(event) {
    event.preventDefault();
    setDropActive(false);
    setLocalFolderName('');
    setLocalFolderMode('none');
    fileHandlesRef.current = new Map();
    rootDirHandleRef.current = null;
    localFilePathsRef.current = new Map();
    const uploaded = await collectDroppedFiles(event.dataTransfer);
    await uploadFiles(uploaded);
  }

  async function handleScan() {
    if (!jobId) {
      setMessage('Upload files first.');
      return;
    }

    setLoading(true);
    setStep('scanning');
    setMessage('Scanning CSS selectors...');

    try {
      const response = await fetch(`/api/scan/${jobId}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Scan failed.');

      setSummary(data.summary);
      setEntries(data.entries);
      setCommentEntries(Array.isArray(data.commentEntries) ? data.commentEntries : []);
      setPerformanceReport(data.performance || null);
      setLastCssRemoval(null);
      setLastCommentRemoval(null);
      const selectedByDefault = new Set(
        data.entries
          .filter((entry) => entry.status === 'unused')
          .filter((entry) => !selectorMatchesProtected(entry.selector, protectedPatterns))
          .map((entry) => entry.id)
      );
      setSelectedIds(selectedByDefault);
      setSelectedCommentIds(new Set((Array.isArray(data.commentEntries) ? data.commentEntries : []).map((entry) => entry.id)));
      setSelectedUnusedCssFiles(new Set());
      setScanWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      const recommendationCount = Array.isArray(data.performance?.recommendations) ? data.performance.recommendations.length : 0;
      const commentCount = Array.isArray(data.commentEntries) ? data.commentEntries.length : 0;
      if (data.summary.totalRules === 0) {
        const commentText = commentCount > 0 ? ` ${commentCount} commented code block(s) were found.` : '';
        setMessage(`Scan complete, but no CSS rules were found. Check that the uploaded folder contains .css files.${commentText}`);
      } else if (data.summary.unusedRules === 0) {
        const performanceText = recommendationCount > 0 ? ` ${recommendationCount} performance recommendation(s) are ready.` : '';
        const commentText = commentCount > 0 ? ` ${commentCount} commented code block(s) were found.` : '';
        setMessage(`Scan complete. No unused selectors were found in this upload.${commentText}${performanceText}`);
      } else {
        const warningText = Array.isArray(data.warnings) && data.warnings.length > 0
          ? ` Skipped ${data.warnings.length} problematic file(s).`
          : '';
        const performanceText = recommendationCount > 0 ? ` ${recommendationCount} performance recommendation(s) are ready.` : '';
        const commentText = commentCount > 0 ? ` ${commentCount} commented code block(s) were found.` : '';
        setMessage(`Scan complete. Found ${data.summary.unusedRules} unused selectors.${commentText}${warningText}${performanceText}`);
      }
      setReportTab(recommendationCount > 0 ? 'performance' : 'css');
      setStep('scanned');
    } catch (error) {
      setMessage(error.message);
      setStep('uploaded');
    } finally {
      setLoading(false);
    }
  }

  function toggleSelection(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleRemove(mode) {
    if (!jobId) return;

    const selectedCssIds = mode === 'css' ? Array.from(selectedIdsForRemoval) : [];
    const selectedCommentIdsToRemove = mode === 'comments' ? selectedCommentIdsForRemoval : [];

    if (mode === 'css' && selectedCssIds.length === 0) {
      setMessage('Please select at least one CSS selector to remove first.');
      return;
    }

    if (mode === 'comments' && selectedCommentIdsToRemove.length === 0) {
      setMessage('Please select at least one comment to remove first.');
      return;
    }

    setLoading(true);
    setStep('removing');
    setMessage(mode === 'css' ? 'Removing selected CSS selectors...' : 'Removing selected comments...');

    try {
      const selectedCssIdSet = new Set(selectedCssIds);
      const selectedCommentIdSet = new Set(selectedCommentIdsToRemove);
      const response = await fetch(`/api/remove/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          removeMode: mode,
          selectedIds: selectedCssIds,
          selectedCommentIds: selectedCommentIdsToRemove,
          protectedPatterns,
          ignoreSmallComments: ignoreShortComments,
          smallCommentMaxLines: shortCommentMaxLines,
          ignoreLiquidDocComments
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Removal failed.');
      setScanWarnings([]);
      const protectedNote = data.protectedSelectorsSkipped > 0
        ? ` ${data.protectedSelectorsSkipped} protected selector(s) were skipped.`
        : '';
      const ignoredNote = protectedPatterns.length > 0
        ? ` Ignored patterns: ${protectedPatterns.join(', ')}.`
        : '';
      const shortCommentNote = ignoreShortComments
        ? ` Short comments (1-${shortCommentMaxLines} lines) were ignored.`
        : '';
      const docCommentNote = ignoreLiquidDocComments
        ? ' Liquid documentation comments were preserved.'
        : '';

      if (localFolderMode === 'handle') {
        setMessage('Writing changes directly to your folder...');
        const exportFiles = Array.isArray(data.changedFiles) ? data.changedFiles : [];
        const result = fileHandlesRef.current.size > 0
          ? await writeFilesToHandleMap(fileHandlesRef.current, exportFiles, localFolderName)
          : { written: 0, failed: 0, firstError: '' };
        const { written, failed, firstError } = result;
        setMessage(
          mode === 'css'
            ? (written > 0
              ? `Done. Removed ${data.removedSelectors} CSS selector(s) and updated ${written} file(s) directly in your folder.${protectedNote}${ignoredNote}`
              : failed > 0
                ? `Removed ${data.removedSelectors} CSS selector(s), but direct write was blocked (${firstError || 'permission or browser access issue'}). Use "Download updated" to save the modified files.${protectedNote}${ignoredNote}`
                : `Removed ${data.removedSelectors} CSS selector(s), but no exact file matches were found for direct writing. Use "Download updated" to save the modified files.${protectedNote}${ignoredNote}`)
            : (written > 0
              ? `Done. Removed ${data.removedComments} comment block(s) and updated ${written} file(s) directly in your folder.${shortCommentNote}${docCommentNote}`
              : failed > 0
                ? `Removed ${data.removedComments} comment block(s), but direct write was blocked (${firstError || 'permission or browser access issue'}). Use "Download updated" to save the modified files.${shortCommentNote}${docCommentNote}`
                : `Removed ${data.removedComments} comment block(s), but no exact file matches were found for direct writing. Use "Download updated" to save the modified files.${shortCommentNote}${docCommentNote}`)
        );
        setStep('applied');
      } else {
        setStep('removed');
        setMessage(
          mode === 'css'
            ? `Removed ${data.removedSelectors} CSS selector(s). Click "Download updated" to save modified files.${protectedNote}${ignoredNote}`
            : `Removed ${data.removedComments} comment block(s)${shortCommentNote}${docCommentNote}. Click "Download updated" to save modified files.${protectedNote}${ignoredNote}`
        );
      }

      if (mode === 'css') {
        const removedCssEntries = entries.filter((entry) => selectedCssIdSet.has(entry.id));
        const removedSelectorBytes = entries
          .filter((entry) => selectedCssIdSet.has(entry.id))
          .reduce((sum, entry) => sum + Number(entry.estimatedBytes || 0), 0);

        setLastCssRemoval({
          removedAt: new Date().toISOString(),
          selectedIds: selectedCssIds,
          removedEntries: removedCssEntries
        });
        setEntries((current) => current.filter((entry) => !selectedCssIdSet.has(entry.id)));
        setSelectedIds(new Set());
        setSelectedCommentIds((current) => {
          const next = new Set(current);
          const removableCommentIds = removableCommentEntries.map((entry) => entry.id);
          const hasAnySelectedComment = removableCommentIds.some((id) => next.has(id));
          if (hasAnySelectedComment || removableCommentIds.length === 0) {
            return next;
          }
          return new Set(removableCommentIds);
        });
        setReportTab('css');
        setSummary((current) => ({
          totalRules: Math.max(0, current.totalRules - selectedCssIdSet.size),
          usedRules: current.usedRules,
          unusedRules: Math.max(0, current.unusedRules - selectedCssIdSet.size),
          estimatedSavingsBytes: Math.max(0, current.estimatedSavingsBytes - removedSelectorBytes)
        }));
        setHasCleanupChanges(true);
      } else {
        const removedCommentEntries = commentEntries.filter((entry) => selectedCommentIdSet.has(entry.id));
        setLastCommentRemoval({
          removedAt: new Date().toISOString(),
          selectedCommentIds: selectedCommentIdsToRemove,
          removedEntries: removedCommentEntries
        });
        setCommentEntries((current) => current.filter((entry) => !selectedCommentIdSet.has(entry.id)));
        setSelectedCommentIds(new Set());
        setReportTab('comments');
        setHasCleanupChanges(true);
      }
    } catch (error) {
      setMessage(error.message);
      setStep('scanned');
    } finally {
      setLoading(false);
    }
  }

  async function deleteFilesFromDirHandle(rootHandle, filePaths) {
    console.log('[CSS-DBG] deleteFilesFromDirHandle called', { rootHandle, filePaths });
    const canWrite = await ensureWritePermission(rootHandle);
    console.log('[CSS-DBG] ensureWritePermission result:', canWrite);
    if (!canWrite) {
      return { deleted: 0, failed: filePaths.length, firstError: 'Write permission not granted for this folder' };
    }

    let deleted = 0;
    let failed = 0;
    let firstError = '';
    for (const relativePath of filePaths) {
      const parts = normalizeRelativePath(relativePath).split('/').filter(Boolean);
      console.log('[CSS-DBG] processing path:', relativePath, '→ parts:', parts);
      if (parts.length === 0) continue;
      try {
        let dirHandle = rootHandle;
        for (let i = 0; i < parts.length - 1; i++) {
          dirHandle = await dirHandle.getDirectoryHandle(parts[i]);
          console.log('[CSS-DBG] navigated into dir:', parts[i], dirHandle);
        }
        await dirHandle.removeEntry(parts[parts.length - 1]);
        console.log('[CSS-DBG] removeEntry SUCCESS:', parts[parts.length - 1]);
        deleted++;
      } catch (err) {
        console.error('[CSS-DBG] removeEntry FAILED for', relativePath, err);
        failed++;
        if (!firstError) firstError = err?.message || 'Delete failed';
      }
    }
    console.log('[CSS-DBG] result:', { deleted, failed, firstError });
    return { deleted, failed, firstError };
  }

  async function handleRemoveUnlinkedFiles() {
    if (!jobId) return;
    const filePaths = Array.from(selectedUnusedCssFiles);
    if (filePaths.length === 0) {
      setMessage('Please select at least one unlinked CSS file to remove.');
      return;
    }
    setLoading(true);
    setMessage('Removing selected unlinked CSS files...');
    try {
      const response = await fetch(`/api/remove-files/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'File removal failed.');
      console.log('[CSS-DBG] server response:', data);
      console.log('[CSS-DBG] localFolderMode:', localFolderMode, '| rootDirHandleRef:', rootDirHandleRef.current);
      const deletedSet = new Set(data.deletedFiles);

      // Prune selectors that belonged to the now-deleted CSS files so they
      // can't be sent to /api/remove (which would fail on missing files).
      const prunedEntries = entries.filter((e) => !deletedSet.has(e.filePath));
      const prunedIds = new Set(entries.filter((e) => deletedSet.has(e.filePath)).map((e) => e.id));
      const deletedUnusedBytes = entries
        .filter((e) => deletedSet.has(e.filePath) && e.status === 'unused')
        .reduce((sum, e) => sum + Number(e.estimatedBytes || 0), 0);
      const deletedUnusedCount = entries.filter((e) => deletedSet.has(e.filePath) && e.status === 'unused').length;
      const deletedUsedCount = entries.filter((e) => deletedSet.has(e.filePath) && e.status === 'used').length;
      const prunedCommentEntries = commentEntries.filter((e) => !deletedSet.has(e.filePath));
      const prunedCommentIds = new Set(commentEntries.filter((e) => deletedSet.has(e.filePath)).map((e) => e.id));
      setEntries(prunedEntries);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of prunedIds) next.delete(id);
        return next;
      });
      setCommentEntries(prunedCommentEntries);
      setSelectedCommentIds((current) => {
        const next = new Set(current);
        for (const id of prunedCommentIds) next.delete(id);
        return next;
      });
      setSummary((current) => ({
        totalRules: Math.max(0, current.totalRules - deletedUnusedCount - deletedUsedCount),
        usedRules: Math.max(0, current.usedRules - deletedUsedCount),
        unusedRules: Math.max(0, current.unusedRules - deletedUnusedCount),
        estimatedSavingsBytes: Math.max(0, current.estimatedSavingsBytes - deletedUnusedBytes)
      }));

      if (localFolderMode === 'handle' && rootDirHandleRef.current) {
        setMessage('Deleting files from your local folder...');
        const localPaths = data.deletedFiles.map(
          (serverPath) => localFilePathsRef.current.get(serverPath) || serverPath
        );
        console.log('[CSS-DBG] server paths → local paths:', data.deletedFiles, '→', localPaths);
        const result = await deleteFilesFromDirHandle(rootDirHandleRef.current, localPaths);
        console.log('[CSS-DBG] deleteFilesFromDirHandle result:', result);
        if (result.deleted > 0) {
          setMessage(`Deleted ${data.count} unlinked CSS file(s) directly from your folder.`);
        } else if (result.failed > 0) {
          setMessage(`Removed ${data.count} file(s) from workspace, but local deletion was blocked (${result.firstError || 'permission issue'}). Use "Download updated" to save changes.`);
        } else {
          setMessage(`Removed ${data.count} unlinked CSS file(s) from workspace.`);
        }
        setStep('applied');
      } else {
        setMessage(`Removed ${data.count} unlinked CSS file(s). Click "Download updated" to save the updated workspace.`);
        setStep('removed');
      }
      setSelectedUnusedCssFiles(new Set());
      setPerformanceReport((current) => {
        if (!current) return current;
        return {
          ...current,
          unusedCssFiles: (current.unusedCssFiles || []).filter((f) => !deletedSet.has(f.filePath)),
          unusedJsFiles: (current.unusedJsFiles || []).filter((f) => !deletedSet.has(f.filePath))
        };
      });
      setHasCleanupChanges(true);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveUnlinkedJsFiles() {
    if (!jobId) return;
    const filePaths = Array.from(selectedUnusedJsFiles);
    if (filePaths.length === 0) {
      setMessage('Please select at least one unlinked JS file to remove.');
      return;
    }
    setLoading(true);
    setMessage('Removing selected unlinked JS files...');
    try {
      const response = await fetch(`/api/remove-files/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'File removal failed.');
      const deletedSet = new Set(data.deletedFiles);

      const prunedCommentEntries = commentEntries.filter((e) => !deletedSet.has(e.filePath));
      const prunedCommentIds = new Set(commentEntries.filter((e) => deletedSet.has(e.filePath)).map((e) => e.id));
      setCommentEntries(prunedCommentEntries);
      setSelectedCommentIds((current) => {
        const next = new Set(current);
        for (const id of prunedCommentIds) next.delete(id);
        return next;
      });

      if (localFolderMode === 'handle' && rootDirHandleRef.current) {
        setMessage('Deleting files from your local folder...');
        const localPaths = data.deletedFiles.map(
          (serverPath) => localFilePathsRef.current.get(serverPath) || serverPath
        );
        const result = await deleteFilesFromDirHandle(rootDirHandleRef.current, localPaths);
        if (result.deleted > 0) {
          setMessage(`Deleted ${data.count} unlinked JS file(s) directly from your folder.`);
        } else if (result.failed > 0) {
          setMessage(`Removed ${data.count} JS file(s) from workspace, but local deletion was blocked (${result.firstError || 'permission issue'}). Use "Download updated" to save changes.`);
        } else {
          setMessage(`Removed ${data.count} unlinked JS file(s) from workspace.`);
        }
        setStep('applied');
      } else {
        setMessage(`Removed ${data.count} unlinked JS file(s). Click "Download updated" to save the updated workspace.`);
        setStep('removed');
      }
      setSelectedUnusedJsFiles(new Set());
      setPerformanceReport((current) => {
        if (!current) return current;
        return {
          ...current,
          unusedCssFiles: (current.unusedCssFiles || []).filter((f) => !deletedSet.has(f.filePath)),
          unusedJsFiles: (current.unusedJsFiles || []).filter((f) => !deletedSet.has(f.filePath))
        };
      });
      setHasCleanupChanges(true);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRestoreAllDeletedThings() {
    if (!jobId) return;

    setLoading(true);
    setStep('removing');
    setMessage('Restoring deleted files, selectors, and comments...');

    try {
      const response = await fetch(`/api/restore/${jobId}`, {
        method: 'POST'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Restore failed.');

      setSummary(data.summary || initialSummary);
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setCommentEntries(Array.isArray(data.commentEntries) ? data.commentEntries : []);
      setPerformanceReport(data.performance || null);
      setScanWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setSelectedUnusedCssFiles(new Set());
      setSelectedUnusedJsFiles(new Set());
      setLastCssRemoval(null);
      setLastCommentRemoval(null);
      setHasCleanupChanges(false);
      setSelectedIds(new Set(
        (Array.isArray(data.entries) ? data.entries : [])
          .filter((entry) => entry.status === 'unused')
          .filter((entry) => !selectorMatchesProtected(entry.selector, protectedPatterns))
          .map((entry) => entry.id)
      ));
      setSelectedCommentIds(new Set((Array.isArray(data.commentEntries) ? data.commentEntries : []).map((entry) => entry.id)));
      setReportTab('css');
      setStep('scanned');

      if (localFolderMode === 'handle' && rootDirHandleRef.current && fileHandlesRef.current.size > 0 && Array.isArray(data.files)) {
        setMessage('Restoring deleted items in your local folder...');
        const restoreResult = await writeFilesToHandleMap(fileHandlesRef.current, data.files, localFolderName);
        if (restoreResult.written > 0) {
          setMessage(`Restored the original workspace and rewrote ${restoreResult.written} file(s) back to your folder.`);
        } else if (restoreResult.failed > 0) {
          setMessage(`Restored the original workspace, but local folder write was blocked (${restoreResult.firstError || 'permission issue'}).`);
        } else {
          setMessage('Restored the original workspace. No local files needed rewriting.');
        }
        setStep('applied');
      } else {
        setMessage(data.message || 'Cleanup restored. The original workspace is back.');
      }
    } catch (error) {
      setMessage(error.message);
      setStep('scanned');
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(kind) {
    if (!jobId) return;

    try {
      const reportKind = kind === 'report-css'
        ? 'css'
        : kind === 'report-comments'
          ? 'comments'
          : '';
      const url = reportKind
        ? `/api/download/${jobId}/report?kind=${reportKind}`
        : `/api/download/${jobId}/${kind}`;
      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed.');
      }

      const blob = await response.blob();
      const fallback = kind === 'optimized'
        ? `updated-${jobId}.zip`
        : kind === 'report-css'
          ? `css-report-${jobId}.pdf`
          : kind === 'report-comments'
            ? `comment-report-${jobId}.pdf`
            : `report-${jobId}.pdf`;
      const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallback);
      downloadBlob(blob, filename);
    } catch (error) {
      setMessage(error.message);
    }
  }

  const hasResults = entries.length > 0 || commentEntries.length > 0;
  const cssRemoveEnabled = selectedIdsForRemoval.size > 0 && !loading && ['scanned', 'removed', 'applied'].includes(step);
  const commentRemoveEnabled = selectedCommentIdsForRemoval.length > 0 && !loading && ['scanned', 'removed', 'applied'].includes(step);
  const unlinkedFilesRemoveEnabled = selectedUnusedCssFiles.size > 0 && !loading && ['scanned', 'removed', 'applied'].includes(step);
  const unlinkedJsFilesRemoveEnabled = selectedUnusedJsFiles.size > 0 && !loading && ['scanned', 'removed', 'applied'].includes(step);
  const performanceRecommendations = Array.isArray(performanceReport?.recommendations)
    ? performanceReport.recommendations
    : [];
  const unusedCssFiles = Array.isArray(performanceReport?.unusedCssFiles)
    ? performanceReport.unusedCssFiles
    : [];
  const unusedJsFiles = Array.isArray(performanceReport?.unusedJsFiles)
    ? performanceReport.unusedJsFiles
    : [];
  const imagesMissingDimensions = Array.isArray(performanceReport?.imagesMissingDimensions)
    ? performanceReport.imagesMissingDimensions
    : [];
  const imagesMissingLazy = Array.isArray(performanceReport?.imagesMissingLazy)
    ? performanceReport.imagesMissingLazy
    : [];
  const cssReportEntries = lastCssRemoval?.removedEntries || [];
  const commentReportEntries = lastCommentRemoval?.removedEntries || [];
  const showCssPdfAction = cssReportEntries.length > 0 && ['removed', 'applied'].includes(step);
  const showCommentPdfAction = commentReportEntries.length > 0 && ['removed', 'applied'].includes(step);
  const canRestoreCleanup = hasCleanupChanges && !loading && Boolean(jobId);

  return (
    <div className="app-shell">
      <main className="container">
        <section className="hero">
          <div>
            <p className="eyebrow">Shopify CSS cleanup automation</p>
            <h1>Scan and review your theme</h1>
            <p className="subcopy">
              Upload a theme folder, CSS files, or a ZIP. The scanner checks `.liquid`, `.html`, and `.js`
              files and protects dynamic Shopify classes from accidental deletion.
            </p>
          </div>

          <div className="status-card">
            <span className={`status-pill status-${step}`}>{step}</span>
            <p>{message}</p>
            {loading ? (
              <div className="loader" aria-label="Loading">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            <div className="status-meta">
              <span>{files.length} uploaded file(s)</span>
              <span>{jobId ? `Job ${jobId.slice(0, 8)}` : 'No job yet'}</span>
              <span>{localFolderName ? `Local folder: ${localFolderName}` : 'No local folder selected'}</span>
            </div>
          </div>
        </section>

        <section className="grid">
          <div className="panel upload-panel">
            <h2>Upload</h2>
            <div className="upload-options">
              <label className="upload-button">
                <input
                  key={`single-${inputKey}`}
                  type="file"
                  multiple
                  accept=".css,.liquid,.html,.js,.zip"
                  onChange={handleUpload}
                  className="file-input"
                />
                <span>Upload files</span>
              </label>
              <button className="upload-button" type="button" onClick={handleFolderButtonClick}>
                <span>Upload folder</span>
              </button>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                webkitdirectory=""
                directory=""
                onChange={handleFolderInputChange}
                className="file-input"
                style={{ display: 'none' }}
              />
            </div>
            <div
              className={`dropzone ${dropActive ? 'dropzone-active' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDropActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDropActive(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setDropActive(false);
              }}
              onDrop={handleDrop}
            >
              <div className="dropzone-copy">
                <strong>Drag and drop files or a folder here</strong>
                <span>Supports single files, theme folders, CSS, Liquid, HTML, JS, and ZIP uploads</span>
              </div>
            </div>

            <div className="file-list">
              {files.length === 0 ? (
                <p className="empty-state">No files uploaded yet.</p>
              ) : (
                files.map(({ file, relativePath }) => (
                  <div key={`${relativePath}-${file.size}-${file.lastModified}`} className="file-row">
                    <span>{relativePath}</span>
                    <span>{formatBytes(file.size)}</span>
                  </div>
                ))
              )}
            </div>

            <div className="actions">
              <button className="primary" onClick={handleScan} disabled={!jobId || loading}>
                {loading && step === 'scanning' ? 'Scanning...' : 'Scan'}
              </button>
              <button className="secondary" onClick={clearResults} disabled={!hasResults}>
                Clear Results
              </button>
            </div>
          </div>

          <div className="panel summary-panel">
            <h2>Report</h2>
            <div className="report-tabs" role="tablist" aria-label="Report sections">
              <button
                type="button"
                className={`report-tab ${reportTab === 'css' ? 'report-tab-active' : ''}`}
                onClick={() => setReportTab('css')}
                role="tab"
                aria-selected={reportTab === 'css'}
              >
                CSS report
                {cssReportEntries.length > 0 ? <span>{cssReportEntries.length}</span> : null}
              </button>
              <button
                type="button"
                className={`report-tab ${reportTab === 'comments' ? 'report-tab-active' : ''}`}
                onClick={() => setReportTab('comments')}
                role="tab"
                aria-selected={reportTab === 'comments'}
              >
                Comment report
                {commentReportEntries.length > 0 ? <span>{commentReportEntries.length}</span> : null}
              </button>
              <button
                type="button"
                className={`report-tab ${reportTab === 'performance' ? 'report-tab-active' : ''}`}
                onClick={() => setReportTab('performance')}
                role="tab"
                aria-selected={reportTab === 'performance'}
              >
                Performance
                {performanceRecommendations.length > 0 ? <span>{performanceRecommendations.length}</span> : null}
              </button>
            </div>

            {canRestoreCleanup ? (
              <div className="report-restore">
                <div>
                  <strong>Cleanup complete</strong>
                  <p>Restore the original uploaded files, selectors, comments, and unlinked file removals in one step.</p>
                </div>
                <button className="secondary" type="button" onClick={handleRestoreAllDeletedThings} disabled={loading}>
                  Restore all deleted things
                </button>
              </div>
            ) : null}

            {reportTab === 'css' ? (
              <>
                <div className="summary-grid">
                  <article>
                    <span>Total rules</span>
                    <strong>{summary.totalRules + cssReportEntries.length}</strong>
                  </article>
                  <article>
                    <span>Removed</span>
                    <strong>{cssReportEntries.length}</strong>
                  </article>
                  <article>
                    <span>Remaining unused</span>
                    <strong>{summary.unusedRules}</strong>
                  </article>
                  <article>
                    <span>Estimated savings</span>
                    <strong>{formatBytes(summary.estimatedSavingsBytes)}</strong>
                  </article>
                </div>

                {scanWarnings.length > 0 ? (
                  <div className="warning-panel">
                    <h3>Scan warnings</h3>
                    <ul className="warning-list">
                      {scanWarnings.map((warning, index) => (
                        <li key={warning.filePath + '-' + warning.sourceType + '-' + index}>
                          <strong>{warning.filePath}</strong>
                          <span>{warning.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="download-actions">
                  <button className="secondary" onClick={() => handleDownload('optimized')} disabled={!(step === 'removed' || step === 'applied')}>
                    Download updated
                  </button>
                  <button className="secondary" onClick={() => handleDownload('report-css')} disabled={cssReportEntries.length === 0}>
                    Download CSS PDF
                  </button>
                </div>
              </>
            ) : reportTab === 'comments' ? (
              <>
                <div className="summary-grid">
                  <article>
                    <span>Comment blocks</span>
                    <strong>{commentEntries.length + commentReportEntries.length}</strong>
                  </article>
                  <article>
                    <span>Removed</span>
                    <strong>{commentReportEntries.length}</strong>
                  </article>
                  <article>
                    <span>Remaining</span>
                    <strong>{commentEntries.length}</strong>
                  </article>
                  <article>
                    <span>Selected for removal</span>
                    <strong>{selectedCommentIdsForRemoval.length}</strong>
                  </article>
                </div>

                <div className="download-actions">
                  <button className="secondary" onClick={() => handleDownload('report-comments')} disabled={commentReportEntries.length === 0}>
                    Download comments PDF
                  </button>
                </div>
              </>
            ) : (
              <div className="performance-panel">
                <div className="performance-head">
                  <div>
                    <h3>Performance recommendations</h3>
                    <p>These are generated from the uploaded Shopify theme and focus on speed, LCP, CLS, and asset weight.</p>
                  </div>
                  <span className="group-count">{performanceRecommendations.length}</span>
                </div>
                {performanceRecommendations.length === 0 ? (
                  <p className="empty-state performance-empty">No performance recommendations yet. Run a scan to generate them.</p>
                ) : (
                  <div className="recommendation-list">
                    {performanceRecommendations.map((recommendation) => {
                      const detailFiles =
                        recommendation.id === 'image-dimensions' ? imagesMissingDimensions
                        : recommendation.id === 'image-lazy-load' ? imagesMissingLazy
                        : null;
                      const isExpanded = expandedRecommendations.has(recommendation.id);
                      return (
                        <article key={recommendation.id} className={`recommendation recommendation-${recommendation.severity}`}>
                          <div className="recommendation-top">
                            <strong>{recommendation.title}</strong>
                            <span>{recommendation.severity}</span>
                          </div>
                          <p>{recommendation.detail}</p>
                          {detailFiles && detailFiles.length > 0 ? (
                            <div className="recommendation-detail">
                              <button
                                type="button"
                                className="recommendation-toggle"
                                onClick={() => setExpandedRecommendations((current) => {
                                  const next = new Set(current);
                                  if (next.has(recommendation.id)) {
                                    next.delete(recommendation.id);
                                  } else {
                                    next.add(recommendation.id);
                                  }
                                  return next;
                                })}
                              >
                                {isExpanded ? '▲ Hide files' : `▼ Show ${detailFiles.length} file(s)`}
                              </button>
                              {isExpanded ? (
                                <ul className="recommendation-files">
                                  {detailFiles.map((f) => (
                                    <li key={f.filePath}>
                                      <span className="rec-filepath">{f.filePath}</span>
                                      <span className="rec-lines">
                                        {f.lines.map((ln) => `L${ln}`).join(' · ')}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}

                <div className="unused-css-panel">
                  <div className="group-head">
                    <div>
                      <h3>CSS files not linked anywhere</h3>
                      <p>These stylesheet files do not appear to be referenced by the scanned theme files. Select files to delete them from the workspace.</p>
                    </div>
                    <div className="group-tools">
                      <span className="group-count">{selectedUnusedCssFiles.size}/{unusedCssFiles.length}</span>
                      <button
                        className="primary"
                        type="button"
                        onClick={handleRemoveUnlinkedFiles}
                        disabled={!unlinkedFilesRemoveEnabled}
                      >
                        {loading ? 'Removing...' : 'Remove selected files'}
                      </button>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>
                            <input
                              type="checkbox"
                              checked={unusedCssFiles.length > 0 && unusedCssFiles.every((f) => selectedUnusedCssFiles.has(f.filePath))}
                              onChange={() => {
                                const allPaths = unusedCssFiles.map((f) => f.filePath);
                                const allSelected = allPaths.length > 0 && allPaths.every((p) => selectedUnusedCssFiles.has(p));
                                setSelectedUnusedCssFiles(allSelected ? new Set() : new Set(allPaths));
                              }}
                            />
                          </th>
                          <th>File</th>
                          <th>Size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unusedCssFiles.length === 0 ? (
                          <tr>
                            <td colSpan="3" className="empty-state">
                              No unlinked CSS files found.
                            </td>
                          </tr>
                        ) : (
                          unusedCssFiles.map((file) => (
                            <tr key={file.filePath} className="row-unused">
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedUnusedCssFiles.has(file.filePath)}
                                  onChange={() => {
                                    setSelectedUnusedCssFiles((current) => {
                                      const next = new Set(current);
                                      if (next.has(file.filePath)) {
                                        next.delete(file.filePath);
                                      } else {
                                        next.add(file.filePath);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              </td>
                              <td className="selector-cell">{file.filePath}</td>
                              <td>{formatBytes(file.bytes)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="unused-css-panel">
                  <div className="group-head">
                    <div>
                      <h3>JS files not linked anywhere</h3>
                      <p>These script files do not appear to be referenced by the scanned theme files. Select files to delete them from the workspace.</p>
                    </div>
                    <div className="group-tools">
                      <span className="group-count">{selectedUnusedJsFiles.size}/{unusedJsFiles.length}</span>
                      <button
                        className="primary"
                        type="button"
                        onClick={handleRemoveUnlinkedJsFiles}
                        disabled={!unlinkedJsFilesRemoveEnabled}
                      >
                        {loading ? 'Removing...' : 'Remove selected files'}
                      </button>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>
                            <input
                              type="checkbox"
                              checked={unusedJsFiles.length > 0 && unusedJsFiles.every((f) => selectedUnusedJsFiles.has(f.filePath))}
                              onChange={() => {
                                const allPaths = unusedJsFiles.map((f) => f.filePath);
                                const allSelected = allPaths.length > 0 && allPaths.every((p) => selectedUnusedJsFiles.has(p));
                                setSelectedUnusedJsFiles(allSelected ? new Set() : new Set(allPaths));
                              }}
                            />
                          </th>
                          <th>File</th>
                          <th>Size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unusedJsFiles.length === 0 ? (
                          <tr>
                            <td colSpan="3" className="empty-state">
                              No unlinked JS files found.
                            </td>
                          </tr>
                        ) : (
                          unusedJsFiles.map((file) => (
                            <tr key={file.filePath} className="row-unused">
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedUnusedJsFiles.has(file.filePath)}
                                  onChange={() => {
                                    setSelectedUnusedJsFiles((current) => {
                                      const next = new Set(current);
                                      if (next.has(file.filePath)) {
                                        next.delete(file.filePath);
                                      } else {
                                        next.add(file.filePath);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              </td>
                              <td className="selector-cell">{file.filePath}</td>
                              <td>{formatBytes(file.bytes)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="panel table-panel">
          <div className="table-head">
            <div>
              <h2>Selectors</h2>
              <p>Use the tab-specific remove button to delete only CSS selectors or only comments.</p>
            </div>
          </div>

          <div className="selector-tabs-wrap">
            <div className="selector-tabs" role="tablist" aria-label="Selector sections">
              <button
                type="button"
                className={`selector-tab ${selectorTab === 'css' ? 'selector-tab-active' : ''}`}
                onClick={() => setSelectorTab('css')}
                role="tab"
                aria-selected={selectorTab === 'css'}
              >
                Removable CSS
                <span>{removableUnusedEntries.length}</span>
              </button>
              <button
                type="button"
                className={`selector-tab ${selectorTab === 'comments' ? 'selector-tab-active' : ''}`}
                onClick={() => setSelectorTab('comments')}
                role="tab"
                aria-selected={selectorTab === 'comments'}
              >
                Commented code
                <span>{commentEntries.length}</span>
              </button>
            </div>
          </div>

          <div className="selector-sections">
            {selectorTab === 'css' ? (
              <div className="selector-tab-panel selector-tab-panel-css">
                <div className="css-workspace">
                  <details className="protected-panel selector-card selector-card-protected" open>
                    <summary className="protected-summary">
                      <div>
                        <h3>Protected selectors</h3>
                        <p>Keep app classes or selector fragments out of removal. Separate entries with commas or new lines.</p>
                      </div>
                      <span className="protected-summary-meta">
                        {protectedSelectors.length} protected
                      </span>
                    </summary>
                    <div className="protected-body">
                      <div className="protected-actions">
                        <button className="secondary" type="button" onClick={addProtectedSelectors} disabled={!protectedSelectorsText.trim()}>
                          Add to ignore
                        </button>
                        <button className="secondary" type="button" onClick={clearProtectedSelectors} disabled={protectedSelectors.length === 0}>
                          Clear all
                        </button>
                      </div>
                      <textarea
                        value={protectedSelectorsText}
                        onChange={(event) => setProtectedSelectorsText(event.target.value)}
                        placeholder=".scaqv-quickadd, .omnisend"
                        rows={3}
                      />
                      <div className="preset-row">
                        <input
                          className="preset-input"
                          type="text"
                          value={presetName}
                          onChange={(event) => setPresetName(event.target.value)}
                          placeholder="Preset name"
                        />
                        <button className="secondary" type="button" onClick={saveProtectedPreset} disabled={!presetName.trim() || protectedSelectorDraft.length === 0}>
                          Save
                        </button>
                        <select
                          className="preset-select"
                          value={activePresetName}
                          onChange={(event) => loadProtectedPreset(event.target.value)}
                        >
                          <option value="">Load preset</option>
                          {savedProtectedPresets.map((preset) => (
                            <option key={preset.name} value={preset.name}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                        <button className="secondary" type="button" onClick={refreshProtectedPresets}>
                          Refresh
                        </button>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => deleteProtectedPreset(activePresetName)}
                          disabled={!activePresetName}
                        >
                          Delete
                        </button>
                      </div>
                      <div className="protected-tags">
                        {protectedSelectors.length === 0 ? (
                          <p className="empty-state">No protected selectors added yet.</p>
                        ) : (
                          protectedSelectors.map((value) => (
                            <button
                              key={value}
                              type="button"
                              className="protected-tag"
                              onClick={() => removeProtectedSelector(value)}
                              title="Click to remove"
                            >
                              <span>{value}</span>
                              <span aria-hidden="true">×</span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </details>

                  <div className="css-selector-grid">
                <section className="selector-group selector-group-unused selector-card">
                  <div className="group-head">
                    <div>
                      <h3>Removable unused selectors</h3>
                      <p>These are preselected for removal.</p>
                    </div>
                    <div className="group-tools">
                      <span className="group-count">{removableUnusedEntries.length}</span>
                      {showCssPdfAction ? (
                        <button className="secondary" type="button" onClick={() => handleDownload('report-css')}>
                          Download CSS PDF
                        </button>
                      ) : null}
                      <button
                        className="primary"
                        onClick={() => handleRemove('css')}
                        disabled={!cssRemoveEnabled}
                      >
                        {loading && step === 'removing' ? 'Removing...' : 'Remove selected CSS'}
                      </button>
                    </div>
                  </div>

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Remove</th>
                          <th>Selector</th>
                          <th>File name</th>
                        </tr>
                      </thead>
                      <tbody>
                        {removableUnusedEntries.length === 0 ? (
                          <tr>
                            <td colSpan="3" className="empty-state">
                              No removable unused selectors found.
                            </td>
                          </tr>
                        ) : (
                          removableUnusedEntries.map((entry) => (
                            <tr key={entry.id} className="row-unused">
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedIds.has(entry.id)}
                                  onChange={() => toggleSelection(entry.id)}
                                />
                              </td>
                              <td className="selector-cell">{entry.selector}</td>
                              <td>{entry.fileName}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="selector-group selector-group-used selector-card selector-card-muted">
                  <div className="group-head">
                    <div>
                      <h3>Ignored app selectors</h3>
                      <p>These matched your protected selectors and will not be removed.</p>
                    </div>
                    <div className="group-tools">
                      <input
                        className="filter-input"
                        type="search"
                        value={ignoredFilter}
                        onChange={(event) => setIgnoredFilter(event.target.value)}
                        placeholder="Filter ignored selectors"
                      />
                      <span className="group-count">
                        {filteredIgnoredUnusedEntries.length}
                        {ignoredFilter.trim() ? ` / ${ignoredUnusedEntries.length}` : ''}
                      </span>
                    </div>
                  </div>

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Selector</th>
                          <th>File name</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredIgnoredUnusedEntries.length === 0 ? (
                          <tr>
                            <td colSpan="2" className="empty-state">
                              {ignoredFilter.trim() ? 'No ignored selectors matched your filter.' : 'No protected selectors matched.'}
                            </td>
                          </tr>
                        ) : (
                          filteredIgnoredUnusedEntries.map((entry) => (
                            <tr key={entry.id} className="row-used">
                              <td className="selector-cell">{entry.selector}</td>
                              <td>{entry.fileName}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
                  </div>
                </div>
              </div>
            ) : (
              <div className="selector-tab-panel selector-tab-panel-comments">
                <div className="comment-stack">
                <section className="selector-group selector-group-comments">
                  <div className="group-head">
                    <div>
                      <h3>Commented code</h3>
                      <p>These comments are preselected for removal. Deselect anything you want to keep.</p>
                    </div>
                    <div className="group-tools">
                      <label className="inline-toggle">
                        <input
                          type="checkbox"
                          checked={ignoreShortComments}
                          onChange={(event) => setIgnoreShortComments(event.target.checked)}
                        />
                        <span>Ignore short comments (1-2 lines)</span>
                      </label>
                      <label className="inline-toggle">
                        <input
                          type="checkbox"
                          checked={ignoreLiquidDocComments}
                          onChange={(event) => setIgnoreLiquidDocComments(event.target.checked)}
                        />
                        <span>Ignore Liquid Documentation</span>
                      </label>
                      <span className="group-count">{selectedCommentIdsForRemoval.length}/{removableCommentEntries.length}</span>
                      {showCommentPdfAction ? (
                        <button className="secondary" type="button" onClick={() => handleDownload('report-comments')}>
                          Download comments PDF
                        </button>
                      ) : null}
                      <button
                        className="primary"
                        onClick={() => handleRemove('comments')}
                        disabled={!commentRemoveEnabled}
                      >
                        {loading && step === 'removing' ? 'Removing...' : 'Remove selected comments'}
                      </button>
                    </div>
                  </div>

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Remove</th>
                          <th>File name</th>
                          <th>Type</th>
                          <th>Lines</th>
                          <th>Comment preview</th>
                        </tr>
                      </thead>
                      <tbody>
                        {removableCommentEntries.length === 0 ? (
                          <tr>
                            <td colSpan="5" className="empty-state">
                              No removable commented code found.
                            </td>
                          </tr>
                        ) : (
                          removableCommentEntries.map((entry) => (
                            <tr key={entry.id} className="row-unused">
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedCommentIds.has(entry.id)}
                                  onChange={() => {
                                    setSelectedCommentIds((current) => {
                                      const next = new Set(current);
                                      if (next.has(entry.id)) {
                                        next.delete(entry.id);
                                      } else {
                                        next.add(entry.id);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              </td>
                              <td>{entry.fileName}</td>
                              <td>{entry.commentType}</td>
                              <td>{entry.lineCount || 1}</td>
                              <td className="selector-cell">{entry.commentPreview}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                {ignoreShortComments ? (
                  <section className="selector-group selector-group-ignored-comments selector-group-spaced">
                    <div className="group-head">
                      <div>
                        <h3>Ignored short comments</h3>
                        <p>These 1-2 line comments were kept out of removal because the toggle is enabled.</p>
                      </div>
                      <span className="group-count">{ignoredShortCommentEntries.length}</span>
                    </div>

                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>File name</th>
                            <th>Type</th>
                            <th>Lines</th>
                            <th>Comment preview</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ignoredShortCommentEntries.length === 0 ? (
                            <tr>
                              <td colSpan="4" className="empty-state">
                                No short comments were ignored.
                              </td>
                            </tr>
                          ) : (
                            ignoredShortCommentEntries.map((entry) => (
                              <tr key={entry.id} className="row-muted">
                                <td>{entry.fileName}</td>
                                <td>{entry.commentType}</td>
                                <td>{entry.lineCount || 1}</td>
                                <td className="selector-cell">{entry.commentPreview}</td>
                               </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ) : null}

                {ignoreLiquidDocComments ? (
                  <section className="selector-group selector-group-ignored-comments selector-group-spaced">
                    <div className="group-head">
                      <div>
                        <h3>Ignored Liquid documentation</h3>
                        <p>Snippet documentation (Accepts/Usage) is preserved to keep your codebase readable.</p>
                      </div>
                      <span className="group-count">{ignoredLiquidDocEntries.length}</span>
                    </div>

                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>File name</th>
                            <th>Type</th>
                            <th>Comment preview</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ignoredLiquidDocEntries.length === 0 ? (
                            <tr>
                              <td colSpan="3" className="empty-state">
                                No Liquid documentation comments found.
                              </td>
                            </tr>
                          ) : (
                            ignoredLiquidDocEntries.map((entry) => (
                              <tr key={entry.id} className="row-muted">
                                <td>{entry.fileName}</td>
                                <td>{entry.commentType}</td>
                                <td className="selector-cell">{entry.commentPreview}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ) : null}
                </div>
              </div>
            )}
          </div>

          <div className="table-footer">
            {selectorTab === 'css' ? (
              <>
                <span>{removableUnusedEntries.length} unused selector(s) preselected</span>
                <span>{ignoredUnusedEntries.length} protected selector(s) ignored</span>
                <span>{selectedIdsForRemoval.size} selected for removal</span>
              </>
            ) : (
              <>
                <span>{removableCommentEntries.length} removable comment block(s)</span>
                <span>{ignoredShortCommentEntries.length} ignored short comment(s)</span>
                <span>{ignoredLiquidDocEntries.length} ignored doc comment(s)</span>
                <span>{selectedCommentIdsForRemoval.length} selected for removal</span>
                <span>{ignoreShortComments ? 'Short comments ignored' : 'All comments included'}</span>
                <span>{ignoreLiquidDocComments ? 'Liquid documentation ignored' : 'All Liquid comments included'}</span>
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
