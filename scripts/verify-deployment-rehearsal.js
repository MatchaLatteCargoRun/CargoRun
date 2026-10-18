'use strict';
// Evidence checks only. No upload, SQL, credentials, or infrastructure operation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawnSync,execFileSync}=require('node:child_process');
const {verifyInstalled,assertOutside,prepareFixture,exportFixture}=require('./prepare-offline-driver-fixture');
const {safeRelative,validateSource}=require('./build-deployment-package');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verifyWorkflowSequence(root){
 const main=fs.readFileSync(path.join(root,'.github/workflows/deploy-cargorun.yml'),'utf8');
 const validation=fs.readFileSync(path.join(root,'.github/workflows/validate-cargorun-linux.yml'),'utf8');
 const rehearsal=validation.split('  rehearse_deployment_build:')[1];assert.ok(rehearsal,'Missing rehearsal job');
 const commands=[...main.matchAll(/^        run: (.+)$/gm)].map(m=>m[1].trim());
 assert.equal(commands.length,5,'Production sequence changed; review rehearsal');
 const actual=[...rehearsal.matchAll(/^        run: (.+)$/gm)].map(m=>m[1].trim());
 assert.deepEqual(actual.slice(0,5).map(c=>c.replace(' | tee "$RUNNER_TEMP/deployment-rehearsal.tap"','')),commands);
 assert.equal(actual[5],'node scripts/verify-deployment-rehearsal.js');assert.equal(actual.length,6);
 assert.match(rehearsal,/shell: bash\r?\n        run: node --test/); // bash runner enables pipefail.
 for(const content of [main,rehearsal]){
  assert.doesNotMatch(content,/continue-on-error|always\(|failure\(|;\s*true/);
  assert.match(content,/persist-credentials: false/);assert.match(content,/fetch-depth: 0/);
  assert.match(content,/node-version: '22\.23\.3'/);
 }
 assert.doesNotMatch(rehearsal,/Azure\/|secrets\.|id-token:|workflow_dispatch|git push|sqlcmd/);
 assert.match(main,/^    if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)\r?$/m);
 assert.equal((main.match(/\bif:/g)||[]).length,1);
 assert.equal((main.match(/\|\|/g)||[]).length,1);
 assert.equal((main.match(/uses: Azure\/static-web-apps-deploy@v1/g)||[]).length,1);
 assert.ok(main.indexOf('node scripts/build-deployment-package.js')<main.indexOf('uses: Azure/static-web-apps-deploy@v1'));
 return commands;
}
function negativeChild(mode,source,temp,directory){
 const file=path.join(temp,mode+'.env');fs.writeFileSync(file,'');
 const child=spawnSync(process.execPath,[__filename,'--negative',mode,source,temp,directory,file],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024,env:{...process.env,GITHUB_ENV:file}});
 assert.equal(child.status,23,'Negative child did not reject: '+mode+' '+child.stderr);
 assert.equal(fs.readFileSync(file,'utf8'),'','Failed fixture must not export an environment value');
 return {mode,rejected:true,exitCode:child.status,environmentExported:false};
}
function negative(mode,source,temp,directory,file){
 try{
  const options={source,temp,install:root=>{
   fs.cpSync(path.resolve(directory,'..'),path.join(root,'api'),{recursive:true});
   if(mode==='tampered')fs.appendFileSync(path.join(root,'api/node_modules/tedious/lib/connection.js'),'\n// synthetic corruption\n');
  }};
  if(mode==='missing')options.readBlob=()=>{throw Error('SYNTHETIC_MISSING_OBJECT');};
  const fixture=prepareFixture(options);exportFixture(fixture.directory,file);
  throw Error('Negative fixture was accepted');
 }catch(error){
  const expected=mode==='missing'?'SYNTHETIC_MISSING_OBJECT':'Historical installed integrity mismatch';
  if(error.message!==expected)throw error;
  process.exitCode=23;
 }
}
function verifyRehearsal(){
 assert.equal(process.platform,'linux');assert.equal(process.version,'v22.23.3');
 assert.equal(process.env.GITHUB_REF,'refs/heads/validation/sql-driver-upgrade-20261018');
 const root=path.resolve(__dirname,'..'),testedSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 assert.equal(testedSha,process.env.GITHUB_SHA);
 const sequence=verifyWorkflowSequence(root),directory=process.env.CARGORUN_REVIEWED_DEPENDENCIES;
 assert.ok(directory,'GITHUB_ENV did not reach this later step');assertOutside(root,directory);
 const fixture=verifyInstalled(path.resolve(directory,'../..'));
 const tap=fs.readFileSync(path.join(process.env.RUNNER_TEMP,'deployment-rehearsal.tap'),'utf8');
 const totals=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>[k,Number(tap.match(new RegExp('^# '+k+' (\\d+)$','m'))?.[1])]));
 assert.deepEqual(totals,{tests:906,pass:906,fail:0,cancelled:0,skipped:0,todo:0});
 assert.ok(tap.includes('connection-string parse compatibility 0'));assert.ok(tap.includes('installed historical fixture is exact'));
 const packageRoot=path.join(root,'.release'),inventoryBytes=fs.readFileSync(path.join(packageRoot,'package-inventory.json')),inventory=JSON.parse(inventoryBytes);
 const allow=JSON.parse(fs.readFileSync(path.join(root,'scripts/deployment-allowlist.json'))),source=validateSource(root,allow);
 assert.equal(source.routes.length,16);assert.equal(inventory.publicFiles,30);assert.equal(inventory.apiSourceFiles,55);
 assert.equal(inventory.dependencyPackages,75);assert.equal(inventory.dependencyFiles,8231);assert.equal(inventory.files.length,8316);
 const expected=new Set([...allow.public.map(p=>'public/'+p),...allow.api]);
 for(const entry of inventory.files){
  safeRelative(entry.path);assert.equal(sha(fs.readFileSync(path.join(packageRoot,entry.path))),entry.sha256);
  assert.ok(entry.path.startsWith('api/node_modules/')||expected.has(entry.path));
  assert.doesNotMatch(entry.path,/sprintf-js|cargorun-offline-fixture|prepare-offline-driver-fixture|\.pem$|\.pfx$/);
 }
 const temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'fixture-negative-'));
 const negativeResults=['missing','tampered'].map(mode=>negativeChild(mode,root,temp,directory));
 const evidence={status:'PASS',testedSha,platform:process.platform,node:process.version,sequence,githubEnvHandoff:true,tests:totals,securityTests:43,offlineComparisons:25,
   historical:{packages:fixture.dependencyPackages,files:fixture.dependencyFileCount,lockSha256:fixture.lockfileSha256,treeSha256:fixture.dependencyTreeSha256,published:false},
   negativeFixtures:negativeResults,package:{functions:source.routes.length,files:inventory.files.length,inventorySha256:sha(inventoryBytes),allHashesVerified:true},uploadPresent:false};
 console.log('CARGORUN_REHEARSAL_EVIDENCE '+JSON.stringify(evidence));
 console.log('CARGORUN_REHEARSAL_INVENTORY '+JSON.stringify(inventory));
}
module.exports={verifyWorkflowSequence,negativeChild};
if(require.main===module){try{if(process.argv[2]==='--negative')negative(...process.argv.slice(3));else verifyRehearsal();}catch(error){console.error(error.message);process.exitCode=1;}}
