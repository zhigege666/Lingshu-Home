#!/usr/bin/env node
// Collect original license/notice files from installed npm packages for shipping.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'dist/licenses/npm'));
const records = [];
const visited = new Set();
const lock = JSON.parse(await fs.readFile(path.join(root, 'web/package-lock.json'), 'utf8'));
const fallbackRoot = path.join(root, 'web/vendor/dependency-notices');
let fallbacks = {};
try { fallbacks = JSON.parse(await fs.readFile(path.join(fallbackRoot, 'manifest.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const filePattern = /^(licen[sc]e|copying|notice|copyright)([._-].*)?$/i;
const sourceExtension = /\.(?:[cm]?[jt]sx?|map|go|rs|py|wasm)$/i;
await fs.mkdir(output, { recursive: true });

async function licenseFiles(directory, depth = 0) {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isFile() && filePattern.test(item.name) && !sourceExtension.test(item.name)) result.push(name);
    if (depth < 4 && item.isDirectory() && !['node_modules', '.git'].includes(item.name)) {
      result.push(...await licenseFiles(name, depth + 1));
    }
  }
  return result;
}

async function collectPackage(directory) {
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!pkg.name || !pkg.version) return;
  const key = `${pkg.name}@${pkg.version}`;
  if (visited.has(key)) return;
  visited.add(key);
  const packageOutput = path.join(output, key.replace(/[^a-zA-Z0-9_.@-]/g, '_'));
  await fs.mkdir(packageOutput, { recursive: true });
  const files = [];
  for (const source of await licenseFiles(directory)) {
    const relative = path.relative(directory, source);
    const name = relative.replaceAll(path.sep, '_');
    const data = await fs.readFile(source);
    await fs.writeFile(path.join(packageOutput, name), data);
    files.push({ path: path.relative(output, path.join(packageOutput, name)), source: relative,
      sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
  if (!files.length && fallbacks[key]) {
    const fallback = fallbacks[key];
    if (path.basename(fallback.file) !== fallback.file) throw new Error(`Invalid notice path for ${key}`);
    const data = await fs.readFile(path.join(fallbackRoot, fallback.file));
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    if (sha256 !== fallback.sha256) throw new Error(`Upstream notice checksum mismatch for ${key}`);
    await fs.writeFile(path.join(packageOutput, fallback.file), data);
    files.push({ path: path.relative(output, path.join(packageOutput, fallback.file)),
      source: fallback.source, licenseCommit: fallback.licenseCommit, sha256 });
  }
  const license = pkg.license || pkg.licenses || 'not specified';
  const lockKey = path.relative(path.join(root, 'web'), directory).split(path.sep).join('/');
  const runtimeDependency = lock.packages?.[lockKey]?.dev !== true;
  records.push({ package: pkg.name, version: pkg.version, runtimeDependency, declaredLicense: license, files,
    status: files.length ? 'original-notices-copied' : 'notice-file-not-found' });
  await collectModules(path.join(directory, 'node_modules'));
}

async function collectModules(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const item of entries) {
    if (!item.isDirectory() || item.name.startsWith('.')) continue;
    const location = path.join(directory, item.name);
    if (item.name.startsWith('@')) {
      for (const scoped of await fs.readdir(location, { withFileTypes: true })) if (scoped.isDirectory()) await collectPackage(path.join(location, scoped.name));
    } else await collectPackage(location);
  }
}

await collectModules(path.join(root, 'web/node_modules'));
if (!records.length) throw new Error('No installed packages found. Run npm ci in web first.');
records.sort((a,b) => a.package.localeCompare(b.package) || a.version.localeCompare(b.version));
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ scope: 'All installed frontend build and runtime dependencies; not all packages are bundled into the browser application.', packages: records }, null, 2) + '\n');
const missing = records.filter(record => !record.files.length);
console.log(`Collected npm notices: ${records.length - missing.length}/${records.length} packages. Manifest: ${output}/manifest.json`);
if (missing.length) {
  console.error('Packages with no upstream notice file:', missing.map(item => `${item.package}@${item.version}`).join(', '));
  if (missing.some(item => item.runtimeDependency)) process.exitCode = 1;
}
