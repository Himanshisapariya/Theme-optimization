import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const backendRoot = path.resolve(__dirname, '..');
export const uploadsRoot = path.join(backendRoot, 'uploads');
export const backupsRoot = path.join(backendRoot, 'backups');

export async function ensureAppDirs() {
  await fs.mkdir(uploadsRoot, { recursive: true });
  await fs.mkdir(backupsRoot, { recursive: true });
}

export function getJobPaths(jobId) {
  const jobRoot = path.join(uploadsRoot, jobId);
  return {
    jobRoot,
    sourceDir: path.join(jobRoot, 'source'),
    cleanedDir: path.join(jobRoot, 'cleaned'),
    reportPath: path.join(jobRoot, 'report.json'),
    manifestPath: path.join(jobRoot, 'manifest.json'),
    backupDir: path.join(backupsRoot, jobId),
    backupOriginalDir: path.join(backupsRoot, jobId, 'original'),
    backupZipPath: path.join(backupsRoot, jobId, 'backup.zip')
  };
}
