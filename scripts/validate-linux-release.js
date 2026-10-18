'use strict';
// Build-only Linux validation. No Azure, GitHub, SQL or deployment command.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync,execFileSync}=require('node:child_process');
const {validateDependencies,safeRelative}=require('./build-deployment-package');
const {readDependencyState,dependencyFileSha256,parseAudit,PRODUCTION_TARGET,PRODUCTION_APPROVAL}=require('./dependency-security-gate');
function requireLinux(platform=process.platform,node=process.version){
  if(platform!=='linux'||node!=='v22.23.3')throw Error('Run on an approved Linux host with Node 22.23.3; this script does not install the host runtime.');
}
function requireApprovedProductionResult(result){
  if(!result||result.error||result.signal||result.status!==0||String(result.stderr||'').trim())
    throw Error('Production audit gate did not return an approved result');
  let evidence;
  try{evidence=parseAudit(String(result.stdout||'').trim());}
  catch{throw Error('Production audit gate returned invalid evidence');}
  const expectedPackages=[];
  if(evidence?.ok!==true||evidence.context!=='production'||evidence.target!==PRODUCTION_TARGET||
      evidence.productionApproval!==PRODUCTION_APPROVAL||evidence.expiresAtUtc!==null||evidence.authorizesDeployment!==false||evidence.baselineId!=='cargorun-driver-12.7.6-20261018'||
      evidence.exceptedAdvisory!==null||
      JSON.stringify(evidence.affectedPackages)!==JSON.stringify(expectedPackages)||
      !Array.isArray(evidence.nonBlockingAdvisories)||evidence.nonBlockingAdvisories.length!==0||evidence.nonBlockingAdvisories.some(x=>typeof x!=='string'||!/^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(x)))
    throw Error('Production audit gate returned an unexpected approval scope');
  return true;
}

// Diagnostic output contains only relative package paths, digests and scalar metadata.
// It observes the failed installation without changing any security decision or bytes.
function emitDependencyDiagnostics(root,{runner=spawnSync,write=console.log}={}){
  const actual=readDependencyState(root),deps=validateDependencies(root);
  const policy=JSON.parse(fs.readFileSync(path.join(root,'docs/dependency-security-baseline.json'),'utf8'));
  const keys=['lockfileSha256','dependencyPackages','dependencyFileCount','dependencyTreeSha256'];
  const select=value=>Object.fromEntries(keys.map(key=>[key,value[key]]));
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const files=deps.files.slice().sort().map(relative=>{
    safeRelative(relative);
    if(/[\x00-\x1f\x7f]/.test(relative))throw Error('Unsafe diagnostic path');
    const bytes=fs.readFileSync(path.join(deps.directory,relative));
    return {path:relative,sha256:hash(bytes),fingerprintSha256:dependencyFileSha256(relative,bytes)};
  });
  if(files.length!==actual.dependencyFileCount||hash(JSON.stringify(files.map(f=>[f.path,f.fingerprintSha256])))!==actual.dependencyTreeSha256)
    throw Error('Dependency diagnostic snapshot changed');
  const version=runner(process.platform==='win32'?'npm.cmd':'npm',['--version'],
    {cwd:root,encoding:'utf8',shell:process.platform==='win32',timeout:30000,maxBuffer:4096});
  if(version.error||version.signal||version.status!==0||!/^\d+\.\d+\.\d+$/.test(String(version.stdout).trim()))
    throw Error('Dependency diagnostic npm version unavailable');
  const hidden=fs.readFileSync(path.join(deps.directory,'.package-lock.json'));
  let crlf=0,bareLf=0,bareCr=0;
  for(let i=0;i<hidden.length;i++){
    if(hidden[i]===13){if(hidden[i+1]===10){crlf++;i++;}else bareCr++;}
    else if(hidden[i]===10)bareLf++;
  }
  const format=bareCr?'BARE_CR':crlf&&bareLf?'MIXED':crlf?'CRLF':bareLf?'LF':'NONE';
  const rawDependencyTreeSha256=hash(JSON.stringify(files.map(f=>[f.path,f.sha256])));
  const summary={schemaVersion:2,rawDependencyTreeSha256,platform:process.platform,node:process.version,npm:version.stdout.trim(),
    expected:select(policy),actual:select(actual),
    hiddenLockfile:{path:'.package-lock.json',bytes:hidden.length,sha256:hash(hidden),lineEndings:{format,crlf,bareLf,bareCr}}};
  write('CARGORUN_DEPENDENCY_DIAGNOSTIC '+JSON.stringify(summary));
  for(const file of files)write('CARGORUN_DEPENDENCY_FILE '+JSON.stringify(file));
  write('CARGORUN_DEPENDENCY_DIAGNOSTIC_END '+JSON.stringify({files:files.length,sha256:actual.dependencyTreeSha256,rawSha256:rawDependencyTreeSha256}));
}
function runDependencyTests(root,{runner=spawnSync,diagnose=emitDependencyDiagnostics,write=console.log}={}){
  const result=runner(process.execPath,['--test','--test-concurrency=1'],
    {cwd:root,stdio:'inherit',env:{...process.env,NODE_PATH:''},shell:false});
  if(result.error||result.signal||result.status!==0){
    try{diagnose(root,{write});}
    catch{write('CARGORUN_DEPENDENCY_DIAGNOSTIC_ERROR '+JSON.stringify({code:'DIAGNOSTIC_UNAVAILABLE'}));}
    const error=Error('Validation step failed: Node test suite');
    error.exitCode=Number.isInteger(result.status)&&result.status>0&&result.status<=255?result.status:1;
    throw error;
  }
}

function validateLinux(){
  requireLinux();
  const source=path.resolve(__dirname,'..'),task=fs.mkdtempSync(path.join(os.tmpdir(),'cargorun-linux-release-'));
  const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const git=args=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim();
  const testedSha=git(['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40}$/.test(testedSha)||testedSha!==process.env.GITHUB_SHA||
      process.env.GITHUB_REF!=='refs/heads/validation/sql-driver-upgrade-20261018')throw Error('Unexpected validation commit/ref');
  if(git(['status','--porcelain']))throw Error('Validation source must be clean');
  if(execFileSync('npm',['--version'],{encoding:'utf8'}).trim()!=='11.11.0')throw Error('Unexpected npm version');
  const clean=path.join(task,'source');fs.mkdirSync(clean);
  const names=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:source,encoding:'utf8'}).split('\0').filter(Boolean))];
  for(const name of names){
    if(name.split('/').includes('node_modules')||name.startsWith('.release/'))throw Error('Dependencies/generated output must not be copied from source');
    const from=path.join(source,name),to=path.join(clean,name);
    if(!fs.lstatSync(from).isFile())throw Error('Source must contain regular files only: '+name);
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
  }
  const run=(program,args,cwd=clean)=>{
    const result=spawnSync(program,args,{cwd,stdio:'inherit',env:{...process.env,NODE_PATH:''},shell:false});
    if(result.error||result.signal||result.status!==0)throw Error('Validation step failed: '+program+' '+args.join(' '));
  };
  const npmArgs=['--yes','npm@11.11.0'];
  run('npx',[...npmArgs,'ci','--prefix','api','--ignore-scripts','--omit=dev','--engine-strict','--no-audit','--no-fund']);
  // The historical installation is an offline comparison fixture only. It is
  // outside the candidate/package and never receives secrets or SQL access.
  const reviewed=path.join(task,'reviewed');fs.mkdirSync(path.join(reviewed,'api'),{recursive:true});
  const reviewedCommit='f3c757ae0a1cad89e2c652f735504592206e485a';
  for(const name of ['package.json','package-lock.json']){
    const bytes=execFileSync('git',['show',reviewedCommit+':api/'+name],{cwd:source});
    if(name==='package-lock.json'&&sha(bytes)!=='2EF5A6BC5F9D74714B9F4FDEDD427840075E825441FEE6DC9F337CD9549E0EE6')throw Error('Historical comparison lock changed');
    fs.writeFileSync(path.join(reviewed,'api',name),bytes);
  }
  run('npx',[...npmArgs,'ci','--prefix','api','--ignore-scripts','--omit=dev','--engine-strict','--no-audit','--no-fund'],reviewed);
  process.env.CARGORUN_REVIEWED_DEPENDENCIES=path.join(reviewed,'api/node_modules');
  if(JSON.parse(fs.readFileSync(path.join(reviewed,'api/node_modules/mssql/package.json'))).version!=='11.0.2'||
      JSON.parse(fs.readFileSync(path.join(reviewed,'api/node_modules/tedious/package.json'))).version!=='18.6.2')throw Error('Historical comparison versions changed');
  let testOutput='';
  runDependencyTests(clean,{runner:(program,args,options)=>{
    const result=spawnSync(program,args,{...options,stdio:'pipe',encoding:'utf8',timeout:1200000,maxBuffer:32*1024*1024});
    testOutput=String(result.stdout||'');process.stdout.write(testOutput);process.stderr.write(String(result.stderr||''));
    fs.writeFileSync(path.join(task,'node-tests.tap'),testOutput);return result;
  }});
  const totals=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>[key,Number(testOutput.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1]??NaN)]));
  if(totals.tests!==897||totals.pass!==897||['fail','cancelled','skipped','todo'].some(k=>totals[k]!==0))throw Error('Unexpected Linux test totals');
  const securityNames=[...fs.readFileSync(path.join(clean,'tests/dependency-security-gate.test.js'),'utf8').matchAll(/^test\('([^']+)'/gm)].map(m=>m[1]);
  securityNames.push(...['info','low','moderate','high','critical'].map(s=>'unrelated '+s+' advisory remains blocking after exception retirement'),
    ...['mssql','tedious','sprintf-js'].map(n=>'a new advisory on '+n+' cannot inherit the retired exception'));
  if(securityNames.length!==43||securityNames.some(name=>!testOutput.includes('# Subtest: '+name)))throw Error('Security suite coverage incomplete');
  run('npx',['--yes','--package=npm@11.11.0','--','node','scripts/dependency-security-gate.js','--context','testing']);
  const productionGate=spawnSync(process.execPath,['scripts/dependency-security-gate.js','--context','production','--target',PRODUCTION_TARGET],
    {cwd:clean,encoding:'utf8',env:{...process.env,NODE_PATH:''},shell:false,timeout:120000,maxBuffer:8*1024*1024});
  requireApprovedProductionResult(productionGate);
  console.log('CARGORUN_PRODUCTION_GATE '+productionGate.stdout.trim());
  console.log('Production security gate verified the remediated dependency baseline with zero findings. Deployment is not authorized.');
  run(process.execPath,['scripts/build-deployment-package.js',path.join(task,'package')]);
  const repeat=path.join(task,'repeat');fs.mkdirSync(path.join(repeat,'api'),{recursive:true});
  for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(clean,'api',name),path.join(repeat,'api',name));
  run('npx',[...npmArgs,'ci','--prefix','api','--ignore-scripts','--omit=dev','--engine-strict','--no-audit','--no-fund'],repeat);
  const inventory=JSON.parse(fs.readFileSync(path.join(task,'package/package-inventory.json'),'utf8'));
  const deps=validateDependencies(repeat);
  const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
  const files=inventory.files.filter(e=>e.path.startsWith('api/node_modules/'));
  if(files.length!==deps.files.length||files.some(e=>hash(path.join(repeat,e.path))!==e.sha256))throw Error('Linux repeat installation differs');
  const allowlist=JSON.parse(fs.readFileSync(path.join(clean,'scripts/deployment-allowlist.json')));
  const expectedFunctions=allowlist.api.filter(p=>p.endsWith('/function.json')).map(p=>p.split('/')[1]).sort();
  const actualFunctions=inventory.files.filter(f=>/^api\/[^/]+\/function.json$/.test(f.path)).map(f=>f.path.split('/')[1]).sort();
  if(expectedFunctions.length!==16||JSON.stringify(actualFunctions)!==JSON.stringify(expectedFunctions)||inventory.publicFiles!==30||inventory.apiSourceFiles!==55)throw Error('Package function/source inventory differs');
  for(const entry of inventory.files){safeRelative(entry.path);if(hash(path.join(task,'package',entry.path))!==entry.sha256)throw Error('Package bytes differ: '+entry.path);}
  const {collectAudit,evaluateAudit}=require('./dependency-security-gate');
  const state=readDependencyState(clean),policy=JSON.parse(fs.readFileSync(path.join(clean,'docs/dependency-security-baseline.json')));
  const freshAudit=collectAudit(clean);evaluateAudit(freshAudit.report,{policy,state,exitCode:freshAudit.exitCode,context:'testing'});
  const evidence={status:'PASS',testedSha,branch:process.env.GITHUB_REF,platform:process.platform,node:process.version,npm:'11.11.0',sourceFiles:names.length,tests:totals,securityTests:securityNames.length,offlineDriverComparisons:25,
    freshAudit:{exitCode:freshAudit.exitCode,vulnerabilities:freshAudit.report.metadata.vulnerabilities},
    securityGates:{testing:'PASS',production:JSON.parse(productionGate.stdout)},
    dependencyIntegrity:{lockfileSha256:state.lockfileSha256,dependencyTreeSha256:state.dependencyTreeSha256,packages:state.dependencyPackages,files:state.dependencyFileCount,repeatFilesCompared:files.length},
    package:{functions:actualFunctions,publicFiles:inventory.publicFiles,apiSourceFiles:inventory.apiSourceFiles,files:inventory.files.length,inventorySha256:hash(path.join(task,'package/package-inventory.json')),allFileHashesVerified:true},
    historicalComparison:{commit:reviewedCommit,isolated:true,published:false},productionApproval:PRODUCTION_APPROVAL,deployed:false};
  fs.writeFileSync(path.join(task,'linux-validation.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log('CARGORUN_LINUX_EVIDENCE '+JSON.stringify(evidence));
}
module.exports={requireLinux,requireApprovedProductionResult,emitDependencyDiagnostics,runDependencyTests};
if(require.main===module){try{validateLinux();}catch(error){console.error(error.message);process.exitCode=error.exitCode||1;}}
