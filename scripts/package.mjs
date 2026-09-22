#!/usr/bin/env node
/**
 * Packages the extension as `build/status-panel-<version>.nimext` plus a `.sha256`.
 *
 * A `.nimext` is a zip that Nimbalyst extracts straight into the app's
 * user-data `extensions/{id}/` directory, so `manifest.json` has to sit at the top level
 * of the archive -- not one directory deep. A release that carries a broken asset
 * is a hard install failure and does *not* fall back to the clone path, so this
 * script re-opens what it wrote and checks it before leaving it on disk.
 *
 * Usage:
 *   node scripts/package.mjs              # clean build, then package
 *   node scripts/package.mjs --no-build   # package the dist/ that is already there
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build');

/** Everything that goes in the archive. Anything not listed here stays out. */
const ARCHIVE_ROOTS = ['manifest.json', 'dist', 'screenshots', 'README.md', 'LICENSE'];

/**
 * Source maps inline the full text of `src/` via `sourcesContent`, and the
 * marketplace review checklist asks for no source in the package. The repo is
 * public, so anyone who needs to debug can build it.
 */
const EXCLUDE = (rel) => rel.endsWith('.map');

const fail = (msg) => {
  console.error(`\n  package: ${msg}\n`);
  process.exit(1);
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    fail(`could not read ${path.relative(root, file)}: ${err.message}`);
  }
};

// ---------------------------------------------------------------- version

const manifest = readJson(path.join(root, 'manifest.json'));
const pkg = readJson(path.join(root, 'package.json'));

if (!manifest.id) fail('manifest.json has no "id" -- the installer rejects that outright');
if (!manifest.version) fail('manifest.json has no "version"');

// The update check in the app compares a release's `tag_name` against the
// manifest version, so drift between the two silently breaks update detection.
// package.json is the third copy; keep all three in lockstep.
if (manifest.version !== pkg.version) {
  fail(`version drift: manifest.json is ${manifest.version} but package.json is ${pkg.version}`);
}

const version = manifest.version;
const assetName = `status-panel-${version}.nimext`;

// ------------------------------------------------------------------ build

if (!process.argv.includes('--no-build')) {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  // npm is a .cmd shim on Windows, and since Node 18.20 those cannot be spawned
  // without a shell -- without this the build fails with EINVAL.
  // Passed as one string rather than argv, because argv + shell warns (DEP0190).
  const build = spawnSync('npm run build', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (build.error) fail(`could not run npm run build: ${build.error.message}`);
  if (build.status !== 0) fail(`npm run build exited with ${build.status}`);
}

// ------------------------------------------------------------------- pack

const entries = [];

const addFile = (abs, rel) => {
  if (EXCLUDE(rel)) return;
  entries.push({ abs, rel });
};

const addTree = (abs, rel) => {
  for (const name of fs.readdirSync(abs).sort()) {
    const childAbs = path.join(abs, name);
    // Zip entry names are always forward-slashed, on every platform.
    const childRel = `${rel}/${name}`;
    if (fs.statSync(childAbs).isDirectory()) addTree(childAbs, childRel);
    else addFile(childAbs, childRel);
  }
};

for (const name of ARCHIVE_ROOTS) {
  const abs = path.join(root, name);
  if (!fs.existsSync(abs)) {
    if (name === 'manifest.json') fail('manifest.json is missing');
    if (name === 'dist') fail('dist/ is missing -- run without --no-build, or npm run build first');
    continue; // screenshots/, README.md and LICENSE are optional
  }
  if (fs.statSync(abs).isDirectory()) addTree(abs, name);
  else addFile(abs, name);
}

for (const field of ['main', 'styles']) {
  const rel = manifest[field];
  if (rel && !entries.some((e) => e.rel === rel)) {
    fail(`manifest.${field} points at "${rel}", which is not in the package`);
  }
}

// A screenshot path that resolves to nothing is a broken image in the listing
// rather than a failed install, so it would otherwise ship unnoticed.
for (const [i, shot] of (manifest.marketplace?.screenshots ?? []).entries()) {
  for (const field of ['src', 'srcLight']) {
    const rel = shot[field];
    if (rel && !entries.some((e) => e.rel === rel)) {
      fail(`marketplace.screenshots[${i}].${field} points at "${rel}", which is not in the package`);
    }
  }
}

const zip = new AdmZip();
for (const { abs, rel } of entries) zip.addFile(rel, fs.readFileSync(abs));

fs.mkdirSync(outDir, { recursive: true });
const assetPath = path.join(outDir, assetName);
fs.rmSync(assetPath, { force: true });
zip.writeZip(assetPath);

// ----------------------------------------------------------------- verify
// Re-open what we just wrote and run the checks the installer runs, so a
// malformed archive dies here rather than on a user's machine.

const written = new AdmZip(assetPath);
const names = written.getEntries().map((e) => e.entryName);

const manifestEntry = written.getEntry('manifest.json');
if (!manifestEntry) fail('the archive has no top-level manifest.json');

let packaged;
try {
  packaged = JSON.parse(written.readAsText(manifestEntry));
} catch (err) {
  fail(`the packaged manifest.json does not parse: ${err.message}`);
}
if (packaged.id !== manifest.id) fail('the packaged manifest.json has the wrong id');
if (packaged.version !== version) fail('the packaged manifest.json has the wrong version');

for (const name of names) {
  if (name.startsWith('/') || name.includes('..') || /^[a-zA-Z]:/.test(name)) {
    fail(`archive entry escapes the destination directory: ${name}`);
  }
  if (/(^|\/)(node_modules|src|\.git|\.env)(\/|$)/.test(name)) {
    fail(`archive contains something it should not: ${name}`);
  }
}

// ------------------------------------------------------------------ sha256

const bytes = fs.readFileSync(assetPath);
const digest = createHash('sha256').update(bytes).digest('hex');
// sha256sum(1) format, so `sha256sum -c status-panel-<version>.nimext.sha256` works.
fs.writeFileSync(`${assetPath}.sha256`, `${digest}  ${assetName}\n`);

// ------------------------------------------------------------------ report

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`\n  ${assetName}  (${kb(bytes.length)})`);
for (const entry of written.getEntries()) {
  console.log(`    ${entry.entryName}${entry.isDirectory ? '' : `  ${kb(entry.header.size)}`}`);
}
console.log(`\n  sha256  ${digest}`);
console.log(`  out     ${path.relative(root, assetPath)}\n`);
