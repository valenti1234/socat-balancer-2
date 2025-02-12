// copy-assets.js
import * as fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function copyAssets() {
  const sourceDir = path.join(__dirname, 'dist'); // Changed to 'dist'
  const destinationDir = path.join(__dirname, 'backend/public/');

  try {
    // Remove the destination directory (and all its contents) if it exists.
    await fs.rm(destinationDir, { recursive: true, force: true });
    console.log(`Removed destination directory: ${destinationDir}`);

    // Recreate the destination directory.
    await fs.mkdir(destinationDir, { recursive: true });

    const entries = await fs.readdir(sourceDir, { withFileTypes: true });

    for (let entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const destinationPath = path.join(destinationDir, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath);
      } else {
        await fs.copyFile(sourcePath, destinationPath);
        console.log(`Copied ${entry.name} to ${destinationDir}`);
      }
    }

    console.log('Files copied successfully!');
  } catch (err) {
    console.error('Error copying files:', err);
  }
}

async function copyDirectory(source, destination) {
  try {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });

    for (let entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath);
      } else {
        await fs.copyFile(sourcePath, destinationPath);
        console.log(`Copied ${entry.name} to ${destination}`);
      }
    }
  } catch (err) {
    console.error(`Error copying directory ${source}:`, err);
  }
}

copyAssets();
