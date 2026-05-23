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
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => ({
        name: String(item?.name || '').trim(),
        patterns: Array.isArray(item?.patterns)
          ? item.patterns.map((pattern) => String(pattern || '').trim()).filter(Boolean)
          : []
      }))
      .filter((item) => item.name);
  } catch (error) {
    return [];
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
  const [reportTab, setReportTab] = useState('overview');
  const [commentEntries, setCommentEntries] = useState([]);
  const fileHandlesRef = useRef(new Map());
  const folderInputRef = useRef(null);
  const [localFolderName, setLocalFolderName] = useState('');
  const [localFolderMode, setLocalFolderMode] = useState('none');
  const [protectedSelectorsText, setProtectedSelectorsText] = useState('');
  const [protectedSelectors, setProtectedSelectors] = useState([]);
  const [ignoredFilter, setIgnoredFilter] = useState('');
  const [presetName, setPresetName] = useState('');
  const [savedProtectedPresets, setSavedProtectedPresets] = useState(() => readProtectedPresets());
  const [activePresetName, setActivePresetName] = useState('');
  const [selectedCommentIds, setSelectedCommentIds] = useState(new Set());
  const [ignoreShortComments, setIgnoreShortComments] = useState(false);
  const [selectorTab, setSelectorTab] = useState('css');
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
  const commentEntriesById = useMemo(
    () => new Map(commentEntries.map((entry) => [entry.id, entry])),
    [commentEntries]
  );
  const selectedCommentIdsForRemoval = useMemo(() => {
    const ids = Array.from(selectedCommentIds);
    if (!ignoreShortComments) return ids;

    return ids.filter((id) => Number(commentEntriesById.get(id)?.lineCount || 0) > shortCommentMaxLines);
  }, [selectedCommentIds, ignoreShortComments, commentEntriesById]);
  const ignoredShortCommentEntries = useMemo(() => {
    if (!ignoreShortComments) return [];
    return commentEntries.filter((entry) => Number(entry?.lineCount || 0) > 0 && Number(entry.lineCount) <= shortCommentMaxLines);
  }, [commentEntries, ignoreShortComments]);
  const removableCommentEntries = useMemo(() => {
    if (!ignoreShortComments) return commentEntries;
    return commentEntries.filter((entry) => Number(entry?.lineCount || 0) > shortCommentMaxLines);
  }, [commentEntries, ignoreShortComments]);
  function clearResults() {
    setSummary(initialSummary);
    setEntries([]);
    setSelectedIds(new Set());
    setCommentEntries([]);
    setSelectedCommentIds(new Set());
    setScanWarnings([]);
    setPerformanceReport(null);
    setReportTab('overview');
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

    setProtectedSelectors((current) => [...new Set([...current, ...nextValues])]);
    setProtectedSelectorsText('');
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
    if (!name || protectedSelectors.length === 0) return;

    setSavedProtectedPresets((current) => {
      const next = [
        { name, patterns: [...protectedSelectors] },
        ...current.filter((preset) => preset.name !== name)
      ];
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(PROTECTED_PRESETS_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
    setActivePresetName(name);
  }

  function loadProtectedPreset(name) {
    const preset = savedProtectedPresets.find((item) => item.name === name);
    if (!preset) return;

    setProtectedSelectors([...preset.patterns]);
    setPresetName(preset.name);
    setActivePresetName(preset.name);
    setProtectedSelectorsText('');
  }

  function deleteProtectedPreset(name) {
    setSavedProtectedPresets((current) => {
      const next = current.filter((preset) => preset.name !== name);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(PROTECTED_PRESETS_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });

    if (activePresetName === name) {
      setActivePresetName('');
    }
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
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PROTECTED_PRESETS_STORAGE_KEY, JSON.stringify(savedProtectedPresets));
  }, [savedProtectedPresets]);

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
      const selectedByDefault = new Set(
        data.entries
          .filter((entry) => entry.status === 'unused')
          .filter((entry) => !selectorMatchesProtected(entry.selector, protectedPatterns))
          .map((entry) => entry.id)
      );
      setSelectedIds(selectedByDefault);
      setSelectedCommentIds(new Set((Array.isArray(data.commentEntries) ? data.commentEntries : []).map((entry) => entry.id)));
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
      setReportTab(recommendationCount > 0 ? 'performance' : 'overview');
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

  async function handleRemove() {
    if (!jobId) return;
    if (selectedIds.size === 0 && selectedCommentIdsForRemoval.length === 0) {
      setMessage('Please select at least one unused selector or comment first.');
      return;
    }

    setLoading(true);
    setStep('removing');
    setMessage('Removing unused selectors...');

    try {
      const response = await fetch(`/api/remove/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedIds: Array.from(selectedIds),
          selectedCommentIds: selectedCommentIdsForRemoval,
          protectedPatterns,
          ignoreSmallComments: ignoreShortComments,
          smallCommentMaxLines: shortCommentMaxLines
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
      const commentNote = data.removedComments > 0
        ? ` ${data.removedComments} commented code block(s) were removed.`
        : '';
      const shortCommentNote = ignoreShortComments
        ? ` Short comments (1-${shortCommentMaxLines} lines) were ignored.`
        : '';

      if (localFolderMode === 'handle') {
        setMessage('Writing changes directly to your folder...');
        const exportResponse = await fetch(`/api/export/${jobId}/local`);
        const exportData = await exportResponse.json();
        if (!exportResponse.ok) throw new Error(exportData.error || 'Export failed.');
        const exportFiles = exportData.files || [];
        const result = fileHandlesRef.current.size > 0
          ? await writeFilesToHandleMap(fileHandlesRef.current, exportFiles, localFolderName)
          : { written: 0, failed: 0, firstError: '' };
        const { written, failed, firstError } = result;
        setMessage(
          written > 0
            ? `Done. Removed ${data.removedSelectors} selector(s)${commentNote}${shortCommentNote} and updated ${written} file(s) directly in your folder.${protectedNote}${ignoredNote}`
            : failed > 0
              ? `Removed ${data.removedSelectors} selector(s)${commentNote}${shortCommentNote}, but direct write was blocked (${firstError || 'permission or browser access issue'}). Use "Download updated" to save the modified files.${protectedNote}${ignoredNote}`
              : `Removed ${data.removedSelectors} selector(s)${commentNote}${shortCommentNote}, but no exact file matches were found for direct writing. Use "Download updated" to save the modified files.${protectedNote}${ignoredNote}`
        );
        setStep('applied');
      } else {
        setStep('removed');
        setMessage(`Removed ${data.removedSelectors} selector(s)${commentNote}${shortCommentNote}. Click "Download updated" to save modified files.${protectedNote}${ignoredNote}`);
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
      const response = await fetch(`/api/download/${jobId}/${kind}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed.');
      }

      const blob = await response.blob();
      const fallback = kind === 'optimized'
        ? `updated-${jobId}.zip`
        : `report-${jobId}.pdf`;
      const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallback);
      downloadBlob(blob, filename);
    } catch (error) {
      setMessage(error.message);
    }
  }

  const hasResults = entries.length > 0 || commentEntries.length > 0;
  const removeEnabled = (selectedIds.size > 0 || selectedCommentIdsForRemoval.length > 0) && !loading;
  const performanceRecommendations = Array.isArray(performanceReport?.recommendations)
    ? performanceReport.recommendations
    : [];
  const unusedCssFiles = Array.isArray(performanceReport?.unusedCssFiles)
    ? performanceReport.unusedCssFiles
    : [];

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <main className="container">
        <section className="hero">
          <div>
            <p className="eyebrow">Shopify CSS cleanup automation</p>
            <h1>Scan , Review your theme</h1>
            <p className="subcopy">
              Upload a theme folder, CSS files, or a ZIP. The scanner checks `.liquid`, `.html`, and `.js`
              files, then protects dynamic Shopify classes from accidental deletion.
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
                className={`report-tab ${reportTab === 'overview' ? 'report-tab-active' : ''}`}
                onClick={() => setReportTab('overview')}
                role="tab"
                aria-selected={reportTab === 'overview'}
              >
                Overview
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

            {reportTab === 'overview' ? (
              <>
            <div className="summary-grid">
              <article>
                <span>Total rules</span>
                <strong>{summary.totalRules}</strong>
              </article>
              <article>
                <span>Used</span>
                <strong>{summary.usedRules}</strong>
              </article>
              <article>
                <span>Unused</span>
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
              <button className="secondary" onClick={() => handleDownload('report')} disabled={!(step === 'removed' || step === 'applied')}>
                Download report PDF
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
                    {performanceRecommendations.map((recommendation) => (
                      <article key={recommendation.id} className={`recommendation recommendation-${recommendation.severity}`}>
                        <div className="recommendation-top">
                          <strong>{recommendation.title}</strong>
                          <span>{recommendation.severity}</span>
                        </div>
                        <p>{recommendation.detail}</p>
                      </article>
                    ))}
                  </div>
                )}

                <div className="unused-css-panel">
                  <div className="performance-head">
                    <div>
                      <h3>CSS files not linked anywhere</h3>
                      <p>These stylesheet files do not appear to be referenced by the scanned theme files, so they are likely safe to review for removal.</p>
                    </div>
                    <span className="group-count">{unusedCssFiles.length}</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>File</th>
                          <th>Size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unusedCssFiles.length === 0 ? (
                          <tr>
                            <td colSpan="2" className="empty-state">
                              No completely unlinked CSS files were found.
                            </td>
                          </tr>
                        ) : (
                          unusedCssFiles.map((file) => (
                            <tr key={file.filePath} className="row-unused">
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
              <p>Unused selectors are preselected. Uncheck anything you want to keep.</p>
            </div>
            <button className="primary" onClick={handleRemove} disabled={!removeEnabled}>
              {loading && step === 'removing' ? 'Removing...' : 'Remove selected CSS & comments'}
            </button>
          </div>

          <div className="protected-panel">
            <div className="protected-head">
              <div>
                <h3>Protected selectors</h3>
                <p>Paste app classes or selector fragments to keep them out of removal, even if they look unused. Separate multiple entries with commas or new lines.</p>
              </div>
              <div className="protected-actions">
                <button className="secondary" type="button" onClick={addProtectedSelectors} disabled={!protectedSelectorsText.trim()}>
                  Ignore
                </button>
                <button className="secondary" type="button" onClick={clearProtectedSelectors} disabled={protectedSelectors.length === 0}>
                  Clear all
                </button>
              </div>
            </div>
            <textarea
              value={protectedSelectorsText}
              onChange={(event) => setProtectedSelectorsText(event.target.value)}
              placeholder=".scaqv-quickadd, .omnisend"
              rows={4}
            />
            <div className="preset-row">
              <input
                className="preset-input"
                type="text"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                placeholder="Preset name, e.g. Shopify apps"
              />
              <button className="secondary" type="button" onClick={saveProtectedPreset} disabled={!presetName.trim() || protectedSelectors.length === 0}>
                Save preset
              </button>
              <select
                className="preset-select"
                value={activePresetName}
                onChange={(event) => loadProtectedPreset(event.target.value)}
                disabled={savedProtectedPresets.length === 0}
              >
                <option value="">Load saved preset</option>
                {savedProtectedPresets.map((preset) => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name}
                  </option>
                ))}
              </select>
              <button
                className="secondary"
                type="button"
                onClick={() => deleteProtectedPreset(activePresetName)}
                disabled={!activePresetName}
              >
                Delete preset
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

          <div className="selector-sections">
            {selectorTab === 'css' ? (
              <>
                <section className="selector-group selector-group-unused">
                  <div className="group-head">
                    <div>
                      <h3>Removable unused selectors</h3>
                      <p>These are preselected for removal.</p>
                    </div>
                    <span className="group-count">{removableUnusedEntries.length}</span>
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

                <section className="selector-group selector-group-used">
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
              </>
            ) : (
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
                    <span className="group-count">{selectedCommentIdsForRemoval.length}/{removableCommentEntries.length}</span>
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
                  <section className="selector-group selector-group-ignored-comments">
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
              </div>
            )}
          </div>

          <div className="table-footer">
            {selectorTab === 'css' ? (
              <>
                <span>{removableUnusedEntries.length} unused selector(s) preselected</span>
                <span>{ignoredUnusedEntries.length} protected selector(s) ignored</span>
                <span>{selectedIds.size} selected for removal</span>
              </>
            ) : (
              <>
                <span>{removableCommentEntries.length} removable comment block(s)</span>
                <span>{ignoredShortCommentEntries.length} ignored short comment(s)</span>
                <span>{selectedCommentIdsForRemoval.length} selected for removal</span>
                <span>{ignoreShortComments ? 'Short comments ignored' : 'All comments included'}</span>
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
