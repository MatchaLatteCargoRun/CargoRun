'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { canonicalWorktree, verifySource } = require('../scripts/verify-recovery-source');
const root = path.resolve(__dirname, '..');
const baseline = 'cbb579c27d4c1b20d91429abd66d6b6a1963c476';
const branch = 'recovery/cbb579c-controlled';
const mode = fs.existsSync(path.join(root, '.git')) ? 'git' : 'clean';
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('recovery application matches exact baseline Git bytes before deployment', () => {
  const contract = verifySource(root, { mode });
  assert.equal(contract.baselineCommit, baseline);
  assert.equal(contract.sourceFiles.length, 83);
  assert.equal(contract.functions.length, 16);
});

test('an altered baseline Git blob or clean source byte blocks recovery', () => {
  if (mode === 'git') {
    const gitBlob = relative => {
      const bytes = execFileSync('git', ['cat-file', 'blob', baseline + ':' + relative], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
      return relative === 'index.html' ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes;
    };
    assert.throws(() => verifySource(root, { mode, gitBlob }), /Recovery baseline Git blob differs: index.html/);
  } else {
    const sourceFile = relative => {
      const bytes = fs.readFileSync(path.join(root, relative));
      return relative === 'index.html' ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes;
    };
    assert.throws(() => verifySource(root, { mode, sourceFile }), /Recovery application source differs: index.html/);
  }
});

test('Git-free clean copy retains exact 83-file baseline and rejects tampering', t => {
  const original = verifySource(root, { mode });
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'cargorun-recovery-source-test-'));
  t.after(() => fs.rmSync(clean, { recursive: true, force: true }));
  for (const relative of [
    ...original.sourceFiles.map(item => item.path),
    'api/package-lock.json', 'docs/recovery-source-contract.json', 'scripts/deployment-allowlist.json'
  ]) {
    const destination = path.join(clean, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  assert.equal(fs.existsSync(path.join(clean, '.git')), false);
  const copied = verifySource(clean, { mode: 'clean' });
  assert.equal(copied.verifiedSourceSha256, original.verifiedSourceSha256);
  const index = path.join(clean, 'index.html'), before = fs.readFileSync(index);
  fs.writeFileSync(index, Buffer.concat([before, Buffer.from('x')]));
  assert.throws(() => verifySource(clean, { mode: 'clean' }), /Recovery application source differs: index.html/);
  fs.writeFileSync(index, before);
  const missing = path.join(clean, 'api/shared/station.js'), saved = fs.readFileSync(missing);
  fs.rmSync(missing);
  assert.throws(() => verifySource(clean, { mode: 'clean' }), /ENOENT/);
  fs.writeFileSync(missing, saved);
  const unexpected = path.join(clean, 'api/shared/unauthorized.js');
  fs.writeFileSync(unexpected, 'module.exports = {};\n');
  assert.throws(() => verifySource(clean, { mode: 'clean' }), /Recovery application inventory differs/);
  fs.rmSync(unexpected);
  const extraPublic = path.join(clean, 'assets/mobile-art/unauthorized.png');
  fs.writeFileSync(extraPublic, Buffer.from([1]));
  assert.throws(() => verifySource(clean, { mode: 'clean' }), /Recovery application inventory differs/);
  fs.rmSync(extraPublic);
  const manifest = path.join(clean, 'docs/recovery-source-contract.json');
  const originalManifest = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, originalManifest.toString().replace(/\n/g, '\r\n'));
  assert.equal(verifySource(clean, { mode: 'clean' }).verifiedSourceSha256, original.verifiedSourceSha256);
  fs.writeFileSync(manifest, originalManifest.toString().replace('\n', '\r\n'));
  assert.throws(() => verifySource(clean, { mode: 'clean' }), /Mixed source line endings/);
  fs.writeFileSync(manifest, originalManifest.toString().replace(baseline, '0'.repeat(40)));
  assert.throws(() => verifySource(clean, { mode: 'clean' }), /Recovery contract bytes differ/);
});

test('source line-ending allowance rejects mixed and bare CR bytes', () => {
  assert.equal(canonicalWorktree(Buffer.from('a\r\nb\r\n')).toString(), 'a\nb\n');
  assert.throws(() => canonicalWorktree(Buffer.from('a\r\nb\n')), /Mixed/);
  assert.throws(() => canonicalWorktree(Buffer.from('a\rb\n')), /Bare CR/);
});

test('recovery workflow is manual only and gates upload on source, tests, audit and package', () => {
  const workflow = source('.github/workflows/deploy-cargorun.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bpush:|pull_request|schedule:|pull_request_target:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/recovery\/cbb579c-controlled'/);
  assert.match(workflow, /production_branch: "recovery\/cbb579c-controlled"/);
  assert.match(workflow, /app_location: "\.release\/public"/);
  assert.match(workflow, /api_location: "\.release\/api"/);
  assert.match(workflow, /AZURE_STATIC_WEB_APPS_API_TOKEN/);
  const steps = ['verify-recovery-source.js --source', 'npm@11.11.0 ci', 'node --test',
    'dependency-security-gate.js --context production --target cargorun-dev',
    'node scripts/build-deployment-package.js', 'verify-recovery-source.js --package .release',
    'uses: Azure/static-web-apps-deploy@v1'];
  for (let i = 1; i < steps.length; i++) assert.ok(workflow.indexOf(steps[i - 1]) < workflow.indexOf(steps[i]));
});

test('recovery branch push runs validation without deploying or receiving Azure secrets', () => {
  const workflow = source('.github/workflows/validate-cargorun-recovery.yml');
  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- recovery\/cbb579c-controlled/);
  assert.doesNotMatch(workflow, /workflow_dispatch|Azure\/static-web-apps-deploy|secrets\.|deployment_environment/);
  assert.match(workflow, /node scripts\/validate-linux-release.js/);
  assert.match(workflow, /contents: read/);
});
