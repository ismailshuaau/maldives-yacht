import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const publicDir = resolve('public');
const cssFiles = [];

function collectCssFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectCssFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.css')) cssFiles.push(path);
  }
}

if (!existsSync(publicDir)) {
  throw new Error('public output is missing; run the build before checking assets');
}

collectCssFiles(publicDir);
const missing = [];
const urlPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

for (const cssFile of cssFiles) {
  const css = readFileSync(cssFile, 'utf8');
  for (const match of css.matchAll(urlPattern)) {
    const reference = match[2].trim();
    if (!reference || /^(?:data:|https?:|\/\/|#|\/)/i.test(reference)) continue;
    const assetPath = resolve(dirname(cssFile), reference.split(/[?#]/, 1)[0]);
    if (!assetPath.startsWith(`${publicDir}/`) || !existsSync(assetPath)) {
      missing.push(`${relative(publicDir, cssFile)} -> ${reference}`);
    }
  }
}

if (missing.length) {
  throw new Error(`Missing relative CSS assets:\n${missing.map(item => `- ${item}`).join('\n')}`);
}

console.log(`Verified relative asset references in ${cssFiles.length} CSS file${cssFiles.length === 1 ? '' : 's'}.`);
