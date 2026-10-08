'use strict';
// Copies only reviewed files; never installs dependencies or deploys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire, isBuiltin } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const fail = message => { throw new Error(message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(value) || value.includes(':')) fail('Unsafe allowlist path');
  return value;
}
function regularFile(root, relative) {
  safeRelative(relative);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) fail('Symlink/junction forbidden: ' + relative);
  }
  if (!fs.statSync(current).isFile()) fail('Expected file: ' + relative);
  return current;
}
function walk(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    // npm executable shims are unused by this API. Skip their platform-specific symlinks.
    if (!prefix && entry.name === '.bin') continue;
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) fail('Symlink/junction forbidden: ' + relative);
    if (entry.isDirectory()) files.push(...walk(path.join(root, entry.name), relative + '/'));
    else if (entry.isFile()) files.push(relative);
    else fail('Unsupported file type: ' + relative);
  }
  return files;
}
function assertNoSecrets(text, relative) {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/,
    /(?:AccountKey|SharedAccessKey|Password|Pwd)\s*=\s*[^;\s'"\x60\x24{}]{12,}/i,
    /(?:apiKey|clientSecret|accessToken)\s*[:=]\s*['"][A-Za-z0-9_+\/=-]{24,}['"]/i
  ];
  if (patterns.some(pattern => pattern.test(text))) fail('Potential secret in ' + relative);
}
function validateSource(root, allowlist) {
  const publicFiles = allowlist.public.map(safeRelative), apiFiles = allowlist.api.map(safeRelative);
  for (const required of ['index.html','signed-out.html','staticwebapp.config.json','manifest.webmanifest','sw.js']) if (!publicFiles.includes(required)) fail('Required frontend/configuration file omitted: ' + required);
  if (new Set([...publicFiles, ...apiFiles]).size !== publicFiles.length + apiFiles.length) fail('Duplicate allowlist path');
  const forbidden = /(^|\/)(?:docs|tests|migrations|tools|scripts|node_modules|\.git|\.github)(\/|$)|(?:^|\/)(?:AUDIT_REPORT\.md|local\.settings\.json|\.env[^/]*|\.npmrc)$|\.(?:sql|ps1|md|log|pem|key|pfx)$/i;
  for (const file of [...publicFiles, ...apiFiles]) {
    if (forbidden.test(file)) fail('Internal/sensitive file forbidden: ' + file);
    if (publicFiles.includes(file) && (file.startsWith('api/') || !/\.(html|js|png|webmanifest)$/.test(file) && file !== 'staticwebapp.config.json')) fail('Invalid public file: ' + file);
    if (apiFiles.includes(file) && !/^api\/(?:[\w-]+\.json|shared\/[\w-]+\.js|[\w-]+\/(?:index\.js|function\.json))$/.test(file)) fail('Invalid API file: ' + file);
    regularFile(root, file);
  }
  // Fail closed if an API source file or endpoint is missing from the reviewed allowlist.
  const actualApi = [];
  for (const entry of fs.readdirSync(path.join(root, 'api'), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) fail('API symlink forbidden');
    if (entry.isDirectory()) actualApi.push(...walk(path.join(root, 'api', entry.name)).map(p => 'api/' + entry.name + '/' + p));
    else actualApi.push('api/' + entry.name);
  }
  if (JSON.stringify(actualApi.sort()) !== JSON.stringify([...apiFiles].sort())) fail('API source inventory differs from allowlist');
  const routes = apiFiles.filter(p => p.endsWith('/function.json')).flatMap(file => {
    const config = readJson(path.join(root, file));
    const entry = path.posix.join(path.posix.dirname(file), config.scriptFile || 'index.js');
    if (!apiFiles.includes(entry)) fail('Missing function entry: ' + file);
    return config.bindings.filter(b => b.type === 'httpTrigger').map(b => (b.route || path.posix.basename(path.posix.dirname(file))).split('/')[0]);
  });
  const references = new Set();
  for (const file of [...publicFiles, ...apiFiles].filter(p => /\.(js|html|json|webmanifest)$/.test(p))) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assertNoSecrets(text, file);
    if (/\.js$/.test(file)) new vm.Script(text, { filename: file });
    if (/\.html$/.test(file)) for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc\s*=/.test(m[1]) && !/\btype=["']application\/(?:ld\+)?json/.test(m[1])) new vm.Script(m[2], { filename: file + ':inline' });
    }
    if (/\.(json|webmanifest)$/.test(file)) JSON.parse(text);
    if (publicFiles.includes(file)) {
      // HTML attributes, JS literals, PWA icons and service worker assets; dynamic basenames must be unique.
      for (const m of text.matchAll(/['"\x60](\/?(?:[\w.-]+\/)*[\w.-]+\.(?:png|js|css|webmanifest))(?:[?#][^'"\x60]*)?['"\x60]/g)) {
        const asset = m[1].replace(/^\//, '');
        const matches = publicFiles.filter(p => p === asset || (!asset.includes('/') && p.endsWith('/' + asset)));
        if (matches.length !== 1) fail('Missing/ambiguous frontend asset ' + asset + ' in ' + file);
        references.add(matches[0]);
      }
      for (const m of text.matchAll(/['"\x60]\/api\/([\w-]+)/g)) if (!routes.includes(m[1])) fail('Missing API route ' + m[1]);
    } else if (file.endsWith('.js')) {
      const requireFromFile = createRequire(path.join(root, file));
      for (const m of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        if (isBuiltin(m[1])) continue;
        if (!m[1].startsWith('.')) {
          const name = m[1].startsWith('@') ? m[1].split('/').slice(0,2).join('/') : m[1].split('/')[0];
          if (!readJson(path.join(root, 'api/package.json')).dependencies[name]) fail('Undeclared runtime dependency ' + name);
        } else {
          const resolved = path.relative(root, requireFromFile.resolve(m[1])).split(path.sep).join('/');
          if (!apiFiles.includes(resolved)) fail('API import missing from package: ' + resolved);
        }
      }
    }
  }
  return { publicFiles, apiFiles, routes: routes.sort(), assetReferences: [...references].sort() };
}
function validateDependencies(root) {
  const directory = path.join(root, 'api/node_modules');
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) fail('Refusing dependency junction: use an independent npm ci copy');
  const lock = readJson(path.join(root, 'api/package-lock.json')), pkg = readJson(path.join(root, 'api/package.json'));
  if (lock.lockfileVersion !== 3 || JSON.stringify(lock.packages[''].dependencies) !== JSON.stringify(pkg.dependencies)) fail('Lockfile root mismatch');
  const installed = readJson(path.join(directory, '.package-lock.json'));
  const expected = Object.keys(lock.packages).filter(p => p);
  if (JSON.stringify(expected.sort()) !== JSON.stringify(Object.keys(installed.packages).sort())) fail('Installed package inventory differs from lockfile');
  for (const name of expected) {
    const entry = lock.packages[name], actual = installed.packages[name];
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-/.test(entry.integrity || '')) fail('Dependency registry/integrity missing: ' + name);
    if (entry.version !== actual.version || entry.integrity !== actual.integrity || entry.resolved !== actual.resolved) fail('Installed lock mismatch: ' + name);
    if (readJson(path.join(root, 'api', name, 'package.json')).version !== entry.version) fail('Installed version mismatch: ' + name);
  }
  return { directory, packages: expected.length, files: walk(directory) };
}
function buildRelease({ sourceRoot = ROOT, outputRoot = path.join(sourceRoot, '.release') } = {}) {
  sourceRoot = fs.realpathSync(sourceRoot); outputRoot = path.resolve(outputRoot);
  if (fs.existsSync(outputRoot)) fail('Output already exists; use a new empty destination');
  if (sourceRoot === outputRoot || sourceRoot.startsWith(outputRoot + path.sep)) fail('Unsafe output destination');
  const source = validateSource(sourceRoot, readJson(path.join(sourceRoot, 'scripts/deployment-allowlist.json')));
  const dependencies = validateDependencies(sourceRoot);
  const entries = [
    ...source.publicFiles.map(p => ({ from: path.join(sourceRoot,p), to: 'public/' + p })),
    ...source.apiFiles.map(p => ({ from: path.join(sourceRoot,p), to: p })),
    ...dependencies.files.map(p => ({ from: path.join(dependencies.directory,p), to: 'api/node_modules/' + p }))
  ].sort((a,b) => a.to.localeCompare(b.to));
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const entry of entries) {
    const dest = path.join(outputRoot, entry.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(entry.from, dest);
  }
  const files = entries.map(e => ({ path: e.to, bytes: fs.statSync(e.from).size, sha256: hash(path.join(outputRoot, e.to)) }));
  const inventory = { schemaVersion: 1, purpose: 'Locally assembled package; not an Azure deployment artifact.',
    node: process.version, publicFiles: source.publicFiles.length, apiSourceFiles: source.apiFiles.length,
    functions: source.routes, assetReferences: source.assetReferences, dependencyPackages: dependencies.packages,
    dependencyFiles: dependencies.files.length, files };
  // Review evidence stays outside both publication roots.
  fs.writeFileSync(path.join(outputRoot, 'package-inventory.json'), JSON.stringify(inventory,null,2) + '\n');
  console.log(JSON.stringify({ outputRoot, publicFiles: inventory.publicFiles, apiSourceFiles: inventory.apiSourceFiles, functions: source.routes.length, dependencyPackages: dependencies.packages, dependencyFiles: dependencies.files.length }));
  return inventory;
}
module.exports = { safeRelative, assertNoSecrets, validateSource, validateDependencies, buildRelease };
if (require.main === module) {
  try { buildRelease({ outputRoot: process.argv[2] || path.join(ROOT, '.release') }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
