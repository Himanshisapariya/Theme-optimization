import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const backendRoot = path.resolve(__dirname, '..');
export const uploadsRoot = path.join(backendRoot, 'uploads');

export async function ensureAppDirs() {
  await fs.mkdir(uploadsRoot, { recursive: true });
}

export function getJobPaths(jobId) {
  const jobRoot = path.join(uploadsRoot, jobId);
  return {
    jobRoot,
    sourceDir: path.join(jobRoot, 'source'),
    reportPath: path.join(jobRoot, 'report.json'),
    manifestPath: path.join(jobRoot, 'manifest.json')
  };
}
