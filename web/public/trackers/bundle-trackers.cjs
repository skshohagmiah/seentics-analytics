#!/usr/bin/env node
/**
 * Pre-bundle browser trackers before `next build` / `next dev`.
 *
 * Everything lives in public/trackers/:
 *   seentics.js       — source you edit (plain JavaScript)
 *   rrweb-loader.ts   — rrweb lazy loader source
 *
 * This script produces (in the same dir):
 *   seentics.min.js   — minified production bundle  ← used by <script> tag
 *   seentics-dom.min.js — minified rrweb loader (neutral name: filter lists block
 *                         the literal filename `rrweb.min.js`, which silently
 *                         disabled session replay for every blocker user)
 *
 * Script tags in the install snippet use seentics.min.js.
 */
const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const trackersDir = __dirname; // script lives inside public/trackers/

async function main() {
  fs.mkdirSync(trackersDir, { recursive: true });

  // seentics.js lives in public/trackers/ — minify it in place → seentics.min.js
  const minResult = await esbuild.build({
    entryPoints:   [path.join(trackersDir, 'seentics.js')],
    bundle:        true,
    minify:        true,
    format:        'iife',
    target:        ['chrome80', 'firefox80', 'safari14', 'edge80'],
    treeShaking:   true,
    platform:      'browser',
    define:        { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    write:         false,
  });
  const minFile = minResult.outputFiles?.[0];
  if (!minFile?.text) throw new Error('bundle-trackers: no output for seentics.min.js');
  fs.writeFileSync(path.join(trackersDir, 'seentics.min.js'), minFile.text);

  // rrweb-loader.ts lives in public/trackers/ — minify → seentics-dom.min.js
  const rrwebResult = await esbuild.build({
    entryPoints:   [path.join(trackersDir, 'rrweb-loader.ts')],
    bundle:        true,
    minify:        true,
    format:        'iife',
    target:        ['chrome80', 'firefox80', 'safari14', 'edge80'],
    treeShaking:   true,
    platform:      'browser',
    define:        { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    write:         false,
  });
  const rrwebFile = rrwebResult.outputFiles?.[0];
  if (!rrwebFile?.text) throw new Error('bundle-trackers: no output for seentics-dom.min.js');
  fs.writeFileSync(path.join(trackersDir, 'seentics-dom.min.js'), rrwebFile.text);

  console.log('[bundle-trackers] public/trackers/: seentics.min.js, seentics-dom.min.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
