'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const BASELINE = 'cbb579c27d4c1b20d91429abd66d6b6a1963c476';
const REVIEWED = 'cb2033c8dd3928ab8aa05b74eef8550c2d9ec7b5';
const ROOT_LOCK = '2EF5A6BC5F9D74714B9F4FDEDD427840075E825441FEE6DC9F337CD9549E0EE6';
const TREE = 'FA20832CD500FD267124618A8D6EA8F2155B6AD461BA01ADEA1D4194DFED4A0D';
const CONTRACT_SHA = '0EF0A44B06F76E325607A59A488270BB245C7632541BCBB20A5BFB059A7BC27A';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const fail = message => { throw new Error(message); };
const read = file => fs.readFileSync(file);
function canonicalWorktree(bytes) {
  let crlf = 0, lf = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13) { if (bytes[i + 1] !== 10) fail('Bare CR in source'); crlf++; i++; }
    else if (bytes[i] === 10) lf++;
  }
  if (crlf && lf) fail('Mixed source line endings');
  return crlf ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes;
}
function sourceContract(root = ROOT) {
  const bytes = canonicalWorktree(read(path.join(root, 'docs/recovery-source-contract.json')));
  if (sha(bytes) !== CONTRACT_SHA) fail('Recovery contract bytes differ from reviewed baseline evidence');
  const contract = JSON.parse(bytes);
  if (contract.schemaVersion !== 1 || contract.baselineCommit !== BASELINE ||
      contract.reviewedDependencyCommit !== REVIEWED || contract.lockfileSha256 !== ROOT_LOCK ||
      contract.dependencyTreeSha256 !== TREE || contract.sourceFiles?.length !== 83 ||
      contract.publicFiles !== 30 || contract.apiFiles !== 54 ||
      contract.dependencyPackages !== 74 || contract.dependencyFiles !== 7242 ||
      contract.functions?.length !== 16) fail('Recovery contract changed');
  return contract;
}
function applicationFiles(root) {
  const found = [];
  function walk(relative) {
    const dir = path.join(root, relative);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (relative === 'api' && entry.name === 'node_modules') continue;
      const next = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) fail('Recovery application symlink: ' + next);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) found.push(next);
      else fail('Unsupported recovery application file: ' + next);
    }
  }
  walk('api');
  walk('assets');
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:html|js|png|webmanifest|css|json)$/.test(entry.name)) found.push(entry.name);
  }
  return found.sort();
}
function verifySource(root = ROOT, { mode = 'git',
  gitBlob = relative => execFileSync('git', ['cat-file', 'blob', BASELINE + ':' + relative], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
  sourceFile = relative => read(path.join(root, relative)) } = {}) {
  if (!['git', 'clean'].includes(mode)) fail('Invalid recovery source verification mode');
  const contract = sourceContract(root), seen = new Set(), digests = [];
  for (const item of contract.sourceFiles) {
    const relative = item?.path;
    if (typeof relative !== 'string' || relative.includes('\\') || path.posix.isAbsolute(relative) ||
        relative.split('/').some(segment => !segment || segment === '.' || segment === '..') || seen.has(relative) ||
        !/^[A-F0-9]{64}$/.test(item.sha256) || !Number.isInteger(item.bytes)) fail('Invalid recovery source record');
    seen.add(relative);
    if (mode === 'git') {
      const committed = gitBlob(relative);
      if (committed.length !== item.bytes || sha(committed) !== item.sha256)
        fail('Recovery baseline Git blob differs: ' + relative);
    }
    const working = sourceFile(relative);
    const exact = working.length === item.bytes && sha(working) === item.sha256;
    const normalized = exact ? working : canonicalWorktree(working);
    if (!exact && (normalized.length !== item.bytes || sha(normalized) !== item.sha256))
      fail('Recovery application source differs: ' + relative);
    digests.push([relative, item.sha256]);
  }
  const lock = canonicalWorktree(sourceFile('api/package-lock.json'));
  if (sha(lock) !== ROOT_LOCK) fail('Recovery root lockfile differs');
  const allowlist = JSON.parse(read(path.join(root, 'scripts/deployment-allowlist.json')));
  if (allowlist.public.length !== 30 || allowlist.api.length !== 54 ||
      allowlist.api.includes('api/shared/capability-scope.js')) fail('Recovery allowlist differs');
  const expected = new Set(contract.sourceFiles.map(e => e.path));
  expected.add('api/package-lock.json');
  if (JSON.stringify([...expected].sort()) !== JSON.stringify([...allowlist.public, ...allowlist.api].sort()))
    fail('Recovery allowlist differs from verified application files');
  if (JSON.stringify(applicationFiles(root)) !== JSON.stringify([...expected].sort()))
    fail('Recovery application inventory differs');
  return { ...contract, verifiedSourceSha256: sha(Buffer.from(JSON.stringify({
    baseline: BASELINE, contractSha256: CONTRACT_SHA, files: digests.sort((a,b) => a[0].localeCompare(b[0])), lockfileSha256: sha(lock)
  }))) };
}
function verifyPackage(packageRoot, root = ROOT, { mode = 'git' } = {}) {
  const contract = verifySource(root, { mode });
  const { validateDependencies } = require('./build-deployment-package');
  const { readDependencyState } = require('./dependency-security-gate');
  const state = readDependencyState(root), deps = validateDependencies(root);
  if (state.lockfileSha256 !== ROOT_LOCK || state.dependencyTreeSha256 !== TREE ||
      state.dependencyPackages !== 74 || state.dependencyFileCount !== 7242 || deps.files.length !== 7242)
    fail('Recovery dependencies differ');
  const inventory = JSON.parse(read(path.join(packageRoot, 'package-inventory.json')));
  if (inventory.publicFiles !== 30 || inventory.apiSourceFiles !== 54 || inventory.dependencyPackages !== 74 ||
      inventory.dependencyFiles !== 7242 || inventory.files?.length !== 7326 ||
      JSON.stringify(inventory.functions) !== JSON.stringify(contract.functions)) fail('Recovery package inventory differs');
  const expected = new Set();
  for (const item of inventory.files) {
    const relative = item.path;
    if (expected.has(relative) || typeof relative !== 'string' || relative.includes('\\') ||
        relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('Invalid package path');
    expected.add(relative);
    const dest = path.join(packageRoot, relative), stat = fs.lstatSync(dest), bytes = read(dest);
    if (!stat.isFile() || stat.isSymbolicLink() || bytes.length !== item.bytes || sha(bytes) !== item.sha256)
      fail('Recovery package file differs: ' + relative);
    if (relative.startsWith('public/') || relative.startsWith('api/') && !relative.startsWith('api/node_modules/')) {
      const source = relative.startsWith('public/') ? relative.slice(7) : relative;
      const working = read(path.join(root, source));
      if (!(bytes.equals(working) || bytes.equals(canonicalWorktree(working)))) fail('Recovery packaged application source differs: ' + relative);
    }
  }
  function walk(dir, prefix = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + item.name : item.name;
      if (item.isSymbolicLink()) fail('Recovery package symlink');
      if (item.isDirectory()) walk(path.join(dir, item.name), relative);
      else if (item.isFile() && relative !== 'package-inventory.json' && !expected.has(relative)) fail('Unexpected recovery package file: ' + relative);
      else if (!item.isFile()) fail('Unsupported recovery package file');
    }
  }
  walk(packageRoot);
  return { ok: true, baseline: BASELINE, sourceFiles: 83, functions: 16, packageFiles: inventory.files.length,
    dependencyFiles: deps.files.length, lockfileSha256: ROOT_LOCK, dependencyTreeSha256: TREE };
}
module.exports = { canonicalWorktree, verifySource, verifyPackage };
if (require.main === module) {
  try {
    const action = process.argv[2], clean = action === '--clean-source' || action === '--clean-package';
    const sourceMode = clean ? 'clean' : 'git';
    const result = action === '--source' || action === '--clean-source'
      ? verifySource(ROOT, { mode: sourceMode })
      : (action === '--package' || action === '--clean-package') && process.argv.length === 4
        ? verifyPackage(path.resolve(process.argv[3]), ROOT, { mode: sourceMode })
        : fail('Usage: --source | --clean-source | --package ROOT | --clean-package ROOT');
    console.log(JSON.stringify(action.endsWith('source')
      ? { ok: true, baseline: result.baselineCommit, sourceFiles: 83, verifiedSourceSha256: result.verifiedSourceSha256 }
      : result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
