'use strict';
// Offline test fixture only. Never installed in api/, published, or used for SQL.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const {readDependencyState}=require('./dependency-security-gate');
const COMMIT='f3c757ae0a1cad89e2c652f735504592206e485a';
const LOCK_SHA='2EF5A6BC5F9D74714B9F4FDEDD427840075E825441FEE6DC9F337CD9549E0EE6';
const TREE_SHA='FA20832CD500FD267124618A8D6EA8F2155B6AD461BA01ADEA1D4194DFED4A0D';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verifyInputs(pkg,lock){
  if(sha(lock)!==LOCK_SHA)throw Error('Historical comparison lock changed');
  const p=JSON.parse(pkg),l=JSON.parse(lock);
  if(JSON.stringify(p.dependencies)!==JSON.stringify(l.packages[''].dependencies)||
      p.dependencies.mssql!=='^11.0.1'||l.packages['node_modules/mssql'].version!=='11.0.2'||
      l.packages['node_modules/tedious'].version!=='18.6.2')throw Error('Historical comparison manifest changed');
  // Manifest is taken from the exact commit; lifecycle scripts must never execute.
  if(p.scripts)throw Error('Unexpected historical lifecycle scripts');
}
function verifyInstalled(root){
  const state=readDependencyState(root);
  if(state.lockfileSha256!==LOCK_SHA||state.dependencyTreeSha256!==TREE_SHA||
      state.dependencyPackages!==74||state.dependencyFileCount!==7242)
    throw Error('Historical installed integrity mismatch');
  return state;
}
function assertOutside(source,temp){
  const s=fs.realpathSync(source),t=fs.realpathSync(temp),r=path.relative(s,t);
  if(!r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)))
    throw Error('Historical fixture must be outside the source and publication roots');
}
function fixtureEnvironment(env=process.env){
  // Do not forward SQL configuration, GitHub tokens, Azure secrets or npm credentials.
  const allowed=/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;
  return {...Object.fromEntries(Object.entries(env).filter(([k])=>allowed.test(k))),NODE_PATH:'',
    npm_config_registry:'https://registry.npmjs.org',npm_config_ignore_scripts:'true'};
}
function installFixture(root){
  const args=['ci','--prefix','api','--ignore-scripts','--omit=dev','--engine-strict','--no-audit','--no-fund'];
  let program='npx',command=['--yes','npm@11.11.0',...args];
  if(process.platform==='win32'){
    // npm.cmd can select an adjacent Node 24 even when Node 22 leads PATH.
    const launcher=execFileSync('where.exe',['npm.cmd'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
    const npmRoot=path.join(path.dirname(launcher),'node_modules/npm');
    if(JSON.parse(fs.readFileSync(path.join(npmRoot,'package.json'))).version!=='11.11.0')throw Error('Fixture requires npm 11.11.0');
    program=process.execPath;command=[path.join(npmRoot,'bin/npm-cli.js'),...args];
  }
  const result=spawnSync(program,command,{cwd:root,env:fixtureEnvironment(),shell:false,stdio:'inherit',timeout:300000});
  if(result.error||result.signal||result.status!==0)throw Error('Historical fixture installation failed');
}
function prepareFixture({source=path.resolve(__dirname,'..'),temp=process.env.RUNNER_TEMP||os.tmpdir(),
    readBlob=name=>execFileSync('git',['show',COMMIT+':api/'+name],{cwd:source}),
    install=installFixture}={}){
  if(process.version!=='v22.23.3')throw Error('Fixture requires Node 22.23.3');
  assertOutside(source,temp);
  const pkg=readBlob('package.json'),lock=readBlob('package-lock.json');
  verifyInputs(pkg,lock); // Fail before creating/installing anything if blobs are missing/tampered.
  const root=fs.mkdtempSync(path.join(fs.realpathSync(temp),'cargorun-offline-fixture-'));
  fs.mkdirSync(path.join(root,'api'));
  fs.writeFileSync(path.join(root,'api/package.json'),pkg);
  fs.writeFileSync(path.join(root,'api/package-lock.json'),lock);
  install(root);
  verifyInstalled(root); // Verify every installed file against the reviewed fingerprint.
  const directory=path.join(root,'api/node_modules');
  return {directory,root,commit:COMMIT,lockSha256:LOCK_SHA,treeSha256:TREE_SHA,published:false};
}
function exportFixture(directory,file){
  if(/[\r\n]/.test(directory)||!path.isAbsolute(directory))throw Error('Unsafe fixture environment path');
  fs.appendFileSync(file,'CARGORUN_REVIEWED_DEPENDENCIES='+directory+'\n');
}
module.exports={COMMIT,LOCK_SHA,TREE_SHA,verifyInputs,verifyInstalled,assertOutside,fixtureEnvironment,prepareFixture,exportFixture};
if(require.main===module){try{
  if(process.argv.slice(2).join(' ')!=='--github-env'||!process.env.GITHUB_ENV)throw Error('Expected --github-env and GITHUB_ENV');
  const result=prepareFixture();exportFixture(result.directory,process.env.GITHUB_ENV);
  console.log(JSON.stringify(result));
}catch(error){console.error(error.message);process.exitCode=1;}}
