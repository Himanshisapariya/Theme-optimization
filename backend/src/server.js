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
  copyFilesPreservingStructure,
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

async function extractZipBuffer(buffer, targetDir, seenPaths) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    const relativePath = safeRelativePath(entry.name);
    if (isIgnorableUploadPath(relativePath)) continue;
    const outputPath = path.join(targetDir, relativePath);
    if (seenPaths.has(outputPath)) continue;
    seenPaths.add(outputPath);
    const fileBuffer = await entry.async('nodebuffer');
    await saveBuffer(outputPath, fileBuffer);
  }
}

async function copyOriginalCssFiles(sourceDir, backupDir) {
  const cssFiles = await fg(['**/*.css'], {
    cwd: sourceDir,
    onlyFiles: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/backups/**', '**/uploads/**', '**/cleaned/**']
  });

  for (const relativePath of cssFiles) {
    const from = path.join(sourceDir, relativePath);
    const to = path.join(backupDir, relativePath);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

async function replaceDirectoryContents(sourceDir, targetDir) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
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
      warnings: report.warnings || [],
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
      entries: report.entries
    });
  } catch (error) {
    res.status(404).json({ error: 'Job report not found.' });
  }
});

app.post('/api/remove/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { selectedIds = [] } = req.body || {};
    if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
      return res.status(400).json({ error: 'Please select at least one unused selector to remove.' });
    }

    const paths = getJobPaths(jobId);
    const report = await readReport(paths.reportPath);
    const allowedIds = new Set(report.entries.filter((entry) => entry.status === 'unused').map((entry) => entry.id));
    const invalidIds = selectedIds.filter((id) => !allowedIds.has(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: 'One or more selectors are no longer available for removal.' });
    }

    await fs.mkdir(paths.backupOriginalDir, { recursive: true });
    await copyOriginalCssFiles(paths.sourceDir, paths.backupOriginalDir);

    const result = await removeSelectedSelectors(paths.sourceDir, selectedIds, report);
    await copyFilesPreservingStructure(paths.sourceDir, paths.cleanedDir);
    await fs.mkdir(paths.backupDir, { recursive: true });
    await fs.writeFile(paths.manifestPath, JSON.stringify({ selectedIds, removedAt: new Date().toISOString() }, null, 2));

    res.json({
      jobId,
      message: 'Selected selectors were removed directly from the uploaded workspace after backup creation.',
      removedSelectors: result.removedSelectors,
      cleanedDir: result.cleanedDir
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Removal failed.' });
  }
});

app.post('/api/apply/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const paths = getJobPaths(jobId);
    await fs.access(paths.cleanedDir);
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
    await fs.access(paths.cleanedDir);
    const files = await listFiles(paths.cleanedDir);
    if (files.length === 1) {
      const singleFile = files[0];
      const filePath = path.join(paths.cleanedDir, singleFile);
      const buffer = await fs.readFile(filePath);
      const filename = path.basename(singleFile);
      sendBufferDownload(res, buffer, 'application/octet-stream', filename);
      return;
    }

    const zipBuffer = await createZipFromDirectory(paths.cleanedDir);
    sendBufferDownload(res, zipBuffer, 'application/zip', `optimized-${req.params.jobId}.zip`);
  } catch (error) {
    res.status(404).json({ error: 'Cleaned files not found yet. Run removal first.' });
  }
});

app.get('/api/download/:jobId/backup', async (req, res) => {
  try {
    const paths = getJobPaths(req.params.jobId);
    await fs.access(paths.backupOriginalDir);
    const zipBuffer = await createZipFromDirectory(paths.backupOriginalDir);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${req.params.jobId}.zip"`);
    res.send(zipBuffer);
  } catch (error) {
    res.status(404).json({ error: 'Backup not found yet. Run removal first.' });
  }
});

app.get('/api/download/:jobId/report', async (req, res) => {
  try {
    const paths = getJobPaths(req.params.jobId);
    const report = await readReport(paths.reportPath);
    const manifestRaw = await fs.readFile(paths.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    const pdfBuffer = buildRemovalReportPdf({
      jobId: req.params.jobId,
      report,
      selectedIds: manifest.selectedIds || [],
      removedAt: manifest.removedAt
    });

    sendBufferDownload(res, pdfBuffer, 'application/pdf', `report-${req.params.jobId}.pdf`);
  } catch (error) {
    res.status(404).json({ error: 'Report not found yet. Run removal first.' });
  }
});

await ensureAppDirs();

app.listen(port, host, () => {
  console.log(`Backend running on http://${host}:${port}`);
});
