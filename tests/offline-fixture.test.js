'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const helper=require('../scripts/prepare-offline-driver-fixture');
const root=path.resolve(__dirname,'..');
// Tests also run in Linux validator's source copy, which intentionally has no .git.
const historicalLock=Buffer.from(JSON.stringify({}));
test('fixture rejects tampered historical lock before installation',()=>{
  assert.throws(()=>helper.verifyInputs(Buffer.from('{}'),historicalLock),/lock changed/);
});
test('fixture refuses missing historical inputs and never installs',()=>{
  let installed=false;
  assert.throws(()=>helper.prepareFixture({readBlob:()=>{throw Error('Unavailable historical object');},install:()=>{installed=true;}}),/Unavailable historical object/);
  assert.equal(installed,false);
});
test('fixture cannot be prepared in the source or publication tree',()=>{
  for(const temp of [root,path.join(root,'api')])assert.throws(()=>helper.assertOutside(root,temp),/outside/);
  helper.assertOutside(root,os.tmpdir());
});
test('fixture child environment excludes SQL and deployment secrets',()=>{
  const e=helper.fixtureEnvironment({PATH:'safe',TEMP:'safe',DATABASE_CONNECTION_STRING:'secret',GITHUB_TOKEN:'secret',AZURE_STATIC_WEB_APPS_API_TOKEN:'secret',NODE_OPTIONS:'--require unsafe',NPM_TOKEN:'secret'});
  assert.equal(e.PATH,'safe');assert.equal(e.npm_config_ignore_scripts,'true');
  assert.equal(Object.values(e).includes('secret'),false);assert.equal(e.NODE_OPTIONS,undefined);
});
test('fixture environment export is explicit and rejects line injection',()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'fixture-env-test-')),'env');
  const directory=path.join(os.tmpdir(),'reviewed/api/node_modules');helper.exportFixture(directory,file);
  assert.equal(fs.readFileSync(file,'utf8'),'CARGORUN_REVIEWED_DEPENDENCIES='+directory+'\n');
  assert.throws(()=>helper.exportFixture(directory+'\nOTHER=value',file),/Unsafe/);
});
test('installed historical fixture is exact and current production graph is rejected as a substitute',()=>{
  const directory=process.env.CARGORUN_REVIEWED_DEPENDENCIES;
  assert.ok(directory,'Verified fixture must be prepared before this suite');
  const fixtureRoot=path.resolve(directory,'../..');helper.assertOutside(root,fixtureRoot);
  const state=helper.verifyInstalled(fixtureRoot);assert.equal(state.lockfileSha256,helper.LOCK_SHA);
  assert.equal(require(path.join(directory,'mssql/package.json')).version,'11.0.2');
  assert.equal(require(path.join(directory,'tedious/package.json')).version,'18.6.2');
  assert.throws(()=>helper.verifyInstalled(root),/Historical installed integrity mismatch/);
  const altered=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-tamper-test-'));
  fs.cpSync(path.join(fixtureRoot,'api'),path.join(altered,'api'),{recursive:true});
  fs.appendFileSync(path.join(altered,'api/node_modules/tedious/lib/connection.js'),'\n// tampered fixture\n');
  assert.throws(()=>helper.verifyInstalled(altered),/Historical installed integrity mismatch/);
});
test('historical fixture files and orchestration are excluded by publication allowlist',()=>{
  const allow=JSON.parse(fs.readFileSync(path.join(root,'scripts/deployment-allowlist.json')));
  assert.equal([...allow.public,...allow.api].some(p=>/fixture|reviewed|scripts\/|tools\/|tests\//.test(p)),false);
  const {validateSource}=require('../scripts/build-deployment-package');
  allow.public.push('scripts/prepare-offline-driver-fixture.js');
  assert.throws(()=>validateSource(root,allow),/Internal\/sensitive/);
});
test('deployment upload is success-dependent on exact fixture, full tests, production gate and package',()=>{
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/deploy-cargorun.yml'),'utf8');
  assert.match(workflow,/fetch-depth: 0/);assert.match(workflow,/persist-credentials: false/);
  const sequence=['npm@11.11.0 ci','node scripts/prepare-offline-driver-fixture.js --github-env','node --test --test-concurrency=1','node scripts/dependency-security-gate.js --context production --target cargorun-dev','node scripts/build-deployment-package.js','uses: Azure/static-web-apps-deploy@v1'];
  let last=-1;for(const step of sequence){const at=workflow.indexOf(step);assert.ok(at>last,'Required ordered step: '+step);last=at;}
  assert.doesNotMatch(workflow,/continue-on-error|always\(|failure\(|;\s*true/);
  assert.match(workflow,/^    if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)\r?$/m);
  assert.equal((workflow.match(/\bif:/g)||[]).length,1,'Only the exact main-only job guard is permitted');
  assert.equal((workflow.match(/\|\|/g)||[]).length,1,'No shell failure bypass');
  assert.equal((workflow.match(/^  [a-z_]+:\r?$/gm)||[]).filter(x=>x.includes('build_and_deploy')).length,1);
  assert.match(workflow,/permissions:\r?\n  contents: read/);
});
test('Linux validation and deployment share pinned fixture implementation without bypassing branch guard',()=>{
  require('../scripts/verify-deployment-rehearsal').verifyWorkflowSequence(root);
  const script=fs.readFileSync(path.join(root,'scripts/validate-linux-release.js'),'utf8');
  assert.match(script,/prepareFixture\(\{source,temp:task\}\)/);
  assert.match(script,/process.env.CARGORUN_REVIEWED_DEPENDENCIES=fixture.directory/);
  assert.match(script,/process.env.GITHUB_REF!=='refs\/heads\/validation\/sql-driver-upgrade-20261018'/);
  assert.match(script,/totals.tests!==906\|\|totals.pass!==906/);
});
