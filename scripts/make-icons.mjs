#!/usr/bin/env node
/**
 * Generate every platform icon the packaging needs from assets/icon.png:
 *
 *   assets/icon.icns          macOS
 *   assets/icon.ico           Windows
 *   assets/icons/<size>.png   Linux (hicolor theme sizes)
 *
 * electron-builder would otherwise download an "icons" tool bundle from GitHub
 * Releases for each of these conversions, which fails on networks that cannot
 * reach GitHub. Pre-building them removes that download entirely.
 *
 * Uses only macOS tooling (sips, iconutil).
 *
 * Usage: node scripts/make-icons.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets', 'icon.png');

/** Windows picks from these; 256 is the modern shell thumbnail. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
/** Linux desktop environments pick whichever fits. */
const LINUX_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
/** iconutil expects these exact names: base size plus @2x retina variants. */
const ICNS_ENTRIES = [
  [16, 'icon_16x16'],
  [32, 'icon_16x16@2x'],
  [32, 'icon_32x32'],
  [64, 'icon_32x32@2x'],
  [128, 'icon_128x128'],
  [256, 'icon_128x128@2x'],
  [256, 'icon_256x256'],
  [512, 'icon_256x256@2x'],
  [512, 'icon_512x512'],
  [1024, 'icon_512x512@2x'],
];

/** Resize the master icon to `size` and return the PNG bytes. */
function resize(size, outFile) {
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', outFile], { stdio: 'ignore' });
  return readFileSync(outFile);
}

/**
 * Pack PNG images into a Vista+ ICO container: a directory followed by the
 * PNG blobs (no BMP/DIB encoding needed).
 */
function packIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = headerSize;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    // 256 is encoded as 0 in the single-byte width/height fields.
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    header.writeUInt8(0, entry + 2); // palette colours
    header.writeUInt8(0, entry + 3); // reserved
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(image.data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'dsh-d-icons-'));
try {
  // --- Windows .ico -------------------------------------------------------
  const ico = packIco(ICO_SIZES.map((size) => ({ size, data: resize(size, path.join(workDir, `${size}.png`)) })));
  writeFileSync(path.join(root, 'assets', 'icon.ico'), ico);
  console.log(`assets/icon.ico          ${ICO_SIZES.join(', ')} px`);

  // --- Linux PNG set ------------------------------------------------------
  const linuxDir = path.join(root, 'assets', 'icons');
  mkdirSync(linuxDir, { recursive: true });
  for (const size of LINUX_SIZES) {
    writeFileSync(path.join(linuxDir, `${size}x${size}.png`), resize(size, path.join(workDir, `linux-${size}.png`)));
  }
  console.log(`assets/icons/            ${LINUX_SIZES.map((size) => `${size}x${size}`).join(', ')}`);

  // --- macOS .icns --------------------------------------------------------
  const iconset = path.join(workDir, 'icon.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const [size, name] of ICNS_ENTRIES) {
    writeFileSync(path.join(iconset, `${name}.png`), resize(size, path.join(workDir, `${name}.png`)));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'assets', 'icon.icns')]);
  console.log('assets/icon.icns         10 sizes (16–1024 px)');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
