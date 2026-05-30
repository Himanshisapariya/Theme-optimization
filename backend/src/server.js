import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import JSZip from 'jszip';
import fg from 'fast-glob';
import { ensureAppDirs, getJobPaths } from './storage.js';
import {
  readReport,
  removeSelectedSelectors,
  scanWorkspace,
  writeReport
} from './scanner.js';
import { createZipFromDirectory } from './zip.js';
import { buildRemovalReportPdf } from './reportPdf.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = process.env.PORT || 3001;
const host = process.env.HOST || '127.0.0.1';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function safeRelativePath(input) {
  const normalized = path.posix.normalize(String(input).replace(/\\/g, '/'));
  const cleaned = normalized.replace(/^(\.\.(\/|$))+/, '').replace(/^\/+/, '');
  return cleaned || path.basename(String(input));
}

async function saveBuffer(filePath, buffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
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
  const baseName = path.posix.basename(normalized);
  return (
    !normalized ||
    baseName.startsWith('.') ||
    normalized.startsWith('__MACOSX/') ||
    normalized.includes('/__MACOSX/') ||
    normalized.startsWith('.git/') ||
    normalized.includes('/.git/') ||
    IGNORED_UPLOAD_BASENAMES.has(baseName)
  );
}

function collectZipFileEntries(zip) {
  return Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => ({
      entry,
      relativePath: safeRelativePath(entry.name)
    }))
    .filter(({ relativePath }) => !isIgnorableUploadPath(relativePath));
}

function stripSharedRootFolder(relativePaths) {
  if (relativePaths.length <= 1) {
    return { shouldStrip: false, rootName: '' };
  }

  const firstSegments = relativePaths
    .map((relativePath) => relativePath.split('/').filter(Boolean)[0])
    .filter(Boolean);

  const rootName = firstSegments[0];
  const shouldStrip =
    Boolean(rootName) &&
    firstSegments.every((segment) => segment === rootName) &&
    relativePaths.some((relativePath) => relativePath.includes('/'));

  return { shouldStrip, rootName };
}

async function extractZipBuffer(buffer, targetDir, seenPaths) {
  const zip = await JSZip.loadAsync(buffer);
  const fileEntries = collectZipFileEntries(zip);
  const { shouldStrip, rootName } = stripSharedRootFolder(fileEntries.map(({ relativePath }) => relativePath));

  for (const { entry, relativePath } of fileEntries) {
    const normalizedPath = shouldStrip && relativePath.startsWith(`${rootName}/`)
      ? relativePath.slice(rootName.length + 1)
      : relativePath;
    const outputPath = path.join(targetDir, normalizedPath);
    if (seenPaths.has(outputPath)) continue;
    seenPaths.add(outputPath);
    const fileBuffer = await entry.async('nodebuffer');
    await saveBuffer(outputPath, fileBuffer);
  }
}


async function listFiles(dir) {
  return fg(['**/*'], {
    cwd: dir,
    onlyFiles: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/backups/**', '**/uploads/**', '**/cleaned/**']
  });
}

function sendBufferDownload(res, buffer, contentType, filename) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Please upload at least one file.' });
    }

    const jobId = crypto.randomUUID();
    const paths = getJobPaths(jobId);
    await fs.mkdir(paths.sourceDir, { recursive: true });
    const seenPaths = new Set();
    let savedFiles = 0;

    for (const file of files) {
      const relativePath = safeRelativePath(file.originalname || file.name || 'file');
      const destination = path.join(paths.sourceDir, relativePath);
      const isZip = path.extname(relativePath).toLowerCase() === '.zip';

      if (isZip) {
        await extractZipBuffer(file.buffer, paths.sourceDir, seenPaths);
      } else {
        if (isIgnorableUploadPath(relativePath)) continue;
        if (seenPaths.has(destination)) continue;
        seenPaths.add(destination);
        await saveBuffer(destination, file.buffer);
        savedFiles += 1;
      }
    }

    if (savedFiles === 0) {
      return res.status(400).json({ error: 'Upload contained only ignored system files like .DS_Store.' });
    }

    const uploadedFiles = await fg(['**/*'], {
      cwd: paths.sourceDir,
      onlyFiles: true,
      dot: true
    });
    res.json({
      jobId,
      message: 'Upload complete. You can now scan the project.',
      uploadedFiles
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Upload failed.' });
  }
});

app.post('/api/scan/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const paths = getJobPaths(jobId);

    await fs.access(paths.sourceDir);

    const report = await scanWorkspace(paths.sourceDir);
    report.jobId = jobId;
    report.sourceDir = undefined;
    await writeReport(paths.reportPath, report);

    res.json({
      jobId,
      summary: report.summary,
      entries: report.entries,
      commentEntries: report.commentEntries || [],
      warnings: report.warnings || [],
      performance: report.performance || null,
      fileCount: report.cssFiles.length,
      reportPath: paths.reportPath
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Scan failed.' });
  }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  try {
    const paths = getJobPaths(req.params.jobId);
    const report = await readReport(paths.reportPath);
    res.json({
      jobId: req.params.jobId,
      summary: report.summary,
      entries: report.entries,
      commentEntries: report.commentEntries || [],
      performance: report.performance || null
    });
  } catch (error) {
    res.status(404).json({ error: 'Job report not found.' });
  }
});

app.post('/api/remove/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const {
      removeMode = 'css',
      selectedIds = [],
      selectedCommentIds = [],
      protectedPatterns = [],
      ignoreSmallComments = true,
      smallCommentMaxLines = 2,
      ignoreLiquidDocComments = true
    } = req.body || {};

    if ((!Array.isArray(selectedIds) || selectedIds.length === 0) && (!Array.isArray(selectedCommentIds) || selectedCommentIds.length === 0)) {
      return res.status(400).json({ error: 'Please select at least one unused selector or comment to remove.' });
    }

    const mode = String(removeMode || '').toLowerCase();
    const cssSelectedIds = mode === 'comments' ? [] : selectedIds;
    const commentSelectedIds = mode === 'css' ? [] : selectedCommentIds;

    const paths = getJobPaths(jobId);
    const report = await readReport(paths.reportPath);
    const allowedIds = new Set(report.entries.filter((entry) => entry.status === 'unused').map((entry) => entry.id));
    const allowedCommentIds = new Set((report.commentEntries || []).map((entry) => entry.id));
    const invalidIds = cssSelectedIds.filter((id) => !allowedIds.has(id));
    const invalidCommentIds = commentSelectedIds.filter((id) => !allowedCommentIds.has(id));
    if (invalidIds.length > 0 || invalidCommentIds.length > 0) {
      return res.status(400).json({ error: 'One or more selectors are no longer available for removal.' });
    }

    const result = await removeSelectedSelectors(paths.sourceDir, cssSelectedIds, commentSelectedIds, report, protectedPatterns, {
      ignoreSmallComments,
      smallCommentMaxLines,
      ignoreLiquidDocComments
    });

    await fs.writeFile(
      paths.manifestPath,
      JSON.stringify({
        selectedIds: cssSelectedIds,
        selectedCommentIds: commentSelectedIds,
        removeMode: mode,
        protectedPatterns,
        ignoreSmallComments,
        smallCommentMaxLines,
        ignoreLiquidDocComments,
        removedAt: new Date().toISOString()
      }, null, 2)
    );

    res.json({
      jobId,
      message: `Selected selectors and comments were removed directly from the uploaded workspace.${result.protectedSelectorsSkipped > 0 ? ` ${result.protectedSelectorsSkipped} protected selector(s) were skipped.` : ''}`,
      removedSelectors: result.removedSelectors,
      removedComments: result.removedComments,
      protectedSelectorsSkipped: result.protectedSelectorsSkipped,
      workspaceDir: result.workspaceDir,
      changedFiles: result.changedFiles || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Removal failed.' });
  }
});

app.post('/api/remove-files/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { filePaths = [] } = req.body || {};

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return res.status(400).json({ error: 'Please select at least one file to remove.' });
    }

    const paths = getJobPaths(jobId);
    const report = await readReport(paths.reportPath);
    const unusedCssFiles = Array.isArray(report.performance?.unusedCssFiles)
      ? report.performance.unusedCssFiles
      : [];
    const allowedPaths = new Set(unusedCssFiles.map((f) => f.filePath));
    const invalidPaths = filePaths.filter((p) => !allowedPaths.has(p));

    if (invalidPaths.length > 0) {
      return res.status(400).json({ error: 'One or more files are not in the unlinked CSS files list.' });
    }

    const deletedFiles = [];
    for (const relativePath of filePaths) {
      const safePath = safeRelativePath(relativePath);
      const absolutePath = path.join(paths.sourceDir, safePath);
      try {
        await fs.unlink(absolutePath);
        deletedFiles.push(relativePath);
      } catch {
        // file already gone — skip silently
      }
    }

    if (deletedFiles.length > 0) {
      const deletedSet = new Set(deletedFiles);
      report.entries = (report.entries || []).filter((e) => !deletedSet.has(e.filePath));
      report.commentEntries = (report.commentEntries || []).filter((e) => !deletedSet.has(e.filePath));
      if (report.performance?.unusedCssFiles) {
        report.performance.unusedCssFiles = report.performance.unusedCssFiles.filter(
          (f) => !deletedSet.has(f.filePath)
        );
      }
      await writeReport(paths.reportPath, report);
    }

    res.json({ jobId, deletedFiles, count: deletedFiles.length });
  } catch (error) {
    res.status(500).json({ error: error.message || 'File removal failed.' });
  }
});

app.post('/api/apply/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const paths = getJobPaths(jobId);
    await fs.access(paths.sourceDir);
    res.json({
      jobId,
      message: 'The uploaded workspace is already updated when you remove selectors.'
    });
  } catch (error) {
    res.status(404).json({ error: error.message || 'Apply failed. Run removal first.' });
  }
});

app.get('/api/export/:jobId/local', async (req, res) => {
  try {
    const paths = getJobPaths(req.params.jobId);
    await fs.access(paths.sourceDir);
    const files = await fg(['**/*.{css,liquid,html}'], {
      cwd: paths.sourceDir,
      onlyFiles: true,
      dot: true,
      ignore: ['**/node_modules/**', '**/backups/**', '**/uploads/**', '**/cleaned/**']
    });

    const payload = [];
    for (const relativePath of files) {
      const absolutePath = path.join(paths.sourceDir, relativePath);
      const buffer = await fs.readFile(absolutePath);
      payload.push({
        relativePath,
        contentBase64: buffer.toString('base64')
      });
    }

    res.json({
      jobId: req.params.jobId,
      files: payload
    });
  } catch (error) {
    res.status(404).json({ error: error.message || 'Export failed.' });
  }
});

app.get('/api/download/:jobId/optimized', async (req, res) => {
  try {
    const paths = getJobPaths(req.params.jobId);
    await fs.access(paths.sourceDir);
    const files = await listFiles(paths.sourceDir);
    if (files.length === 1) {
      const singleFile = files[0];
      const filePath = path.join(paths.sourceDir, singleFile);
      const buffer = await fs.readFile(filePath);
      const filename = path.basename(singleFile);
      sendBufferDownload(res, buffer, 'application/octet-stream', filename);
      return;
    }

    const zipBuffer = await createZipFromDirectory(paths.sourceDir);
    sendBufferDownload(res, zipBuffer, 'application/zip', `updated-${req.params.jobId}.zip`);
  } catch (error) {
    res.status(404).json({ error: 'Updated files not found yet. Run removal first.' });
  }
});


app.get('/api/download/:jobId/report', async (req, res) => {
  try {
    const paths = getJobPaths(req.params.jobId);
    const report = await readReport(paths.reportPath);
    const manifestRaw = await fs.readFile(paths.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    const reportKind = String(req.query.kind || 'combined').toLowerCase();
    const selectedIds = reportKind === 'comments' ? [] : (manifest.selectedIds || []);
    const selectedCommentIds = reportKind === 'css' ? [] : (manifest.selectedCommentIds || []);
    const filenamePrefix = reportKind === 'comments'
      ? 'comment-report'
      : reportKind === 'css'
        ? 'css-report'
        : 'report';
    const pdfBuffer = buildRemovalReportPdf({
      jobId: req.params.jobId,
      report,
      selectedIds,
      selectedCommentIds,
      removedAt: manifest.removedAt,
      performance: report.performance || null,
      reportKind
    });

    sendBufferDownload(res, pdfBuffer, 'application/pdf', `${filenamePrefix}-${req.params.jobId}.pdf`);
  } catch (error) {
    res.status(404).json({ error: 'Report not found yet. Run removal first.' });
  }
});

await ensureAppDirs();

app.listen(port, host, () => {
  console.log(`Backend running on http://${host}:${port}`);
});
