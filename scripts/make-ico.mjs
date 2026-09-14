#!/usr/bin/env node
/**
 * Generate assets/icon.ico from assets/icon.png using only macOS tooling.
 *
 * electron-builder would otherwise download an "icons" tool bundle from GitHub
 * Releases to convert PNG → ICO, which fails on networks that cannot reach
 * GitHub. Shipping the .ico removes that download for Windows builds.
 *
 * The container is the Vista+ ICO layout: a directory followed by PNG-encoded
 * images (no BMP/DIB encoding needed), which Windows has accepted since Vista.
 *
 * Usage: node scripts/make-ico.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets', 'icon.png');
const target = path.join(root, 'assets', 'icon.ico');

/** Sizes Windows picks from; 256 is the modern shell thumbnail. */
const SIZES = [16, 32, 48, 64, 128, 256];

const workDir = mkdtempSync(path.join(tmpdir(), 'dsh-d-ico-'));
try {
  const images = SIZES.map((size) => {
    const file = path.join(workDir, `icon-${size}.png`);
    // sips is macOS-only, same as the .icns generator this pairs with.
    execFileSync('sips', ['-z', String(size), String(size), source, '--out', file], { stdio: 'ignore' });
    return { size, data: readFileSync(file) };
  });

  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4); // image count

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

  writeFileSync(target, Buffer.concat([header, ...images.map((image) => image.data)]));
  console.log(`已生成 ${path.relative(root, target)}（${images.map((i) => i.size).join(', ')} px）`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
