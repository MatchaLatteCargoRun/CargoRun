'use strict';
// Build-only Linux validation. No Azure, GitHub, SQL or deployment command.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync,execFileSync}=require('node:child_process');
const {validateDependencies}=require('./build-deployment-package');
function requireLinux(platform=process.platform,node=process.version){
  if(platform!=='linux'||node!=='v22.23.3')throw Error('Run on an approved Linux host with Node 22.23.3; this script does not install the host runtime.');
}
function requireProductionDenial(result){
  if(!result||result.error||result.signal||result.status!==1||String(result.stdout||'').trim())
    throw Error('Production audit gate did not return the expected denial');
  let denial;
  try{denial=JSON.parse(String(result.stderr||'').trim())}
  catch{throw Error('Production audit gate returned invalid denial evidence')}
  if(denial?.ok!==false||denial.error!=='PRODUCTION_NOT_APPROVED: testing exception is not release-owner production acceptance')
    throw Error('Production audit gate failed for a reason other than pending release-owner acceptance');
  return true;
}
function validateLinux(){
  requireLinux();
  const source=path.resolve(__dirname,'..'),task=fs.mkdtempSync(path.join(os.tmpdir(),'cargorun-linux-release-'));
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
  run(process.execPath,['--test','--test-concurrency=1']);
  run('npx',['--yes','--package=npm@11.11.0','--','node','scripts/dependency-security-gate.js','--context','testing']);
  const productionGate=spawnSync(process.execPath,['scripts/dependency-security-gate.js','--context','production'],
    {cwd:clean,encoding:'utf8',env:{...process.env,NODE_PATH:''},shell:false,timeout:120000,maxBuffer:8*1024*1024});
  requireProductionDenial(productionGate);
  console.log('Production security gate denied the testing exception as required.');
  run(process.execPath,['scripts/build-deployment-package.js',path.join(task,'package')]);
  const repeat=path.join(task,'repeat');fs.mkdirSync(path.join(repeat,'api'),{recursive:true});
  for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(clean,'api',name),path.join(repeat,'api',name));
  run('npx',[...npmArgs,'ci','--prefix','api','--ignore-scripts','--omit=dev','--engine-strict','--no-audit','--no-fund'],repeat);
  const inventory=JSON.parse(fs.readFileSync(path.join(task,'package/package-inventory.json'),'utf8'));
  const deps=validateDependencies(repeat);
  const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
  const files=inventory.files.filter(e=>e.path.startsWith('api/node_modules/'));
  if(files.length!==deps.files.length||files.some(e=>hash(path.join(repeat,e.path))!==e.sha256))throw Error('Linux repeat installation differs');
  const evidence={status:'PASS',platform:process.platform,node:process.version,sourceFiles:names.length,dependencyFilesCompared:files.length,
    package:path.join(task,'package'),productionApproval:'PENDING_RELEASE_OWNER_ACCEPTANCE',deployed:false};
  fs.writeFileSync(path.join(task,'linux-validation.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
}
module.exports={requireLinux,requireProductionDenial};
if(require.main===module){try{validateLinux();}catch(error){console.error(error.message);process.exitCode=1;}}
