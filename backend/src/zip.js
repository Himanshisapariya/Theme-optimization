import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

async function addFolderToZip(zip, dir, baseDir) {
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const absolutePath = path.join(dir, item.name);
    const relativePath = path.relative(baseDir, absolutePath);
    if (item.isDirectory()) {
      await addFolderToZip(zip, absolutePath, baseDir);
    } else {
      const fileBuffer = await fs.readFile(absolutePath);
      zip.file(relativePath.split(path.sep).join('/'), fileBuffer);
    }
  }
}

export async function createZipFromDirectory(dir) {
  const zip = new JSZip();
  await addFolderToZip(zip, dir, dir);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
