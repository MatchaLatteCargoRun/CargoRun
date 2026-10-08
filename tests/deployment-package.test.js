'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { safeRelative, assertNoSecrets, validateSource, validateDependencies, buildRelease } = require('../scripts/build-deployment-package');
const root = path.resolve(__dirname, '..');
const allowlist = () => JSON.parse(fs.readFileSync(path.join(root, 'scripts/deployment-allowlist.json'), 'utf8'));
test('deployment allowlist includes all API functions, imports and frontend references', () => {
  const checked = validateSource(root, allowlist());
  assert.equal(checked.routes.length, 16);
  assert.ok(checked.routes.includes('configuration-control'));
  assert.ok(checked.routes.includes('mach-fow'));
  assert.ok(checked.assetReferences.includes('sw.js'));
  assert.ok(checked.publicFiles.includes('staticwebapp.config.json'));
  assert.ok(checked.apiFiles.includes('api/package-lock.json'));
});
test('deployment paths reject traversal, absolute paths and alternate separators', () => {
  for (const value of ['../secret', '/secret', 'C:/secret', 'api\\secret', 'api//secret', 'api/./secret']) assert.throws(() => safeRelative(value), /Unsafe/);
});
test('deployment allowlist rejects internal and sensitive files even if explicitly listed', () => {
  for (const file of ['docs/internal.md', 'migrations/change.sql', 'tests/security.test.js', 'api/local.settings.json', '.env', 'AUDIT_REPORT.md']) {
    const list = allowlist(); list.public.unshift(file);
    assert.throws(() => validateSource(root,list), /Internal\/sensitive/);
  }
});
test('deployment fails when a referenced frontend asset is omitted', () => {
  const list = allowlist(); list.public = list.public.filter(p => p !== 'mascot-loader.js');
  assert.throws(() => validateSource(root,list), /Missing\/ambiguous frontend asset/);
});
test('deployment fails when a function entry is omitted', () => {
  const list = allowlist(); list.api = list.api.filter(p => p !== 'api/session/index.js');
  assert.throws(() => validateSource(root,list), /API source inventory/);
});
test('deployment secret diagnostics report paths without echoing credentials', () => {
  const secret = 'ghp_' + 'x'.repeat(40);
  assert.throws(() => assertNoSecrets(secret, 'example.js'), error => error.message === 'Potential secret in example.js' && !error.message.includes(secret));
  assert.doesNotThrow(() => assertNoSecrets("const key = process.env.API_KEY;", 'example.js'));
});
test('deployment rejects node_modules junctions without modifying their target', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cargorun-package-test-'));
  const target = path.join(temp, 'dependencies');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target,'sentinel'), 'unchanged');
  fs.mkdirSync(path.join(temp,'source/api'), {recursive:true});
  fs.symlinkSync(target,path.join(temp,'source/api/node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => validateDependencies(path.join(temp,'source')), /Refusing dependency junction/);
    assert.equal(fs.readFileSync(path.join(target,'sentinel'),'utf8'), 'unchanged');
  } finally {
    fs.unlinkSync(path.join(temp,'source/api/node_modules'));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temp,{recursive:true});
  }
});
test('deployment refuses to overwrite an existing destination', () => {
  assert.throws(() => buildRelease({sourceRoot:root,outputRoot:root}), /Output already exists/);
});
test('workflow publishes isolated roots after clean install, tests and packaging', () => {
  const workflow = fs.readFileSync(path.join(root,'.github/workflows/deploy-cargorun.yml'),'utf8');
  assert.match(workflow,/app_location: "\.release\/public"/);
  assert.match(workflow,/api_location: "\.release\/api"/);
  assert.match(workflow,/skip_app_build: true/);
  assert.match(workflow,/skip_api_build: true/);
  assert.match(workflow,/npm@11\.11\.0 -- node scripts\/dependency-security-gate\.js --context production --target cargorun-dev/);
  assert.doesNotMatch(workflow,/continue-on-error|audit[^\r\n]*\|\|/);
  assert.ok(workflow.indexOf('npm@11.11.0 ci') < workflow.indexOf('node --test'));
  assert.ok(workflow.indexOf('node --test') < workflow.indexOf('node scripts/build-deployment-package.js'));
  assert.ok(workflow.indexOf('node scripts/build-deployment-package.js') < workflow.indexOf('uses: Azure/static-web-apps-deploy@v1'));
});
