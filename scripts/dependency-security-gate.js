'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateDependencies } = require('./build-deployment-package');
const ROOT = path.resolve(__dirname, '..');
const PRODUCTION_TARGET = 'cargorun-dev';
const PRODUCTION_APPROVAL = 'LOCAL_CANDIDATE_REQUIRES_SEPARATE_RELEASE_APPROVAL';
const BASELINE_SHA256 = "03B5D460E8F5DD258CFFC6E30126811116656046CA7BD2651FDFDC9262A15C9C";
const LEVELS = ['info','low','moderate','high','critical'];
const SCOPED = ['mssql','tedious'];
const sha = data => crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
const fail = (code, message) => { throw new Error(code + ': ' + message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (o,k) => Object.hasOwn(o,k);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = file => JSON.parse(fs.readFileSync(file,'utf8'));
// Accept only the Git LF blob or a complete CRLF conversion of that same byte sequence.
function canonicalLockfileBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('DEPENDENCY_DRIFT','lockfile bytes unavailable');
  let crlf=0, bareLf=0;
  for (let i=0;i<bytes.length;i++) {
    if (bytes[i]===13) {
      if (bytes[i+1]!==10) fail('DEPENDENCY_DRIFT','bare CR in lockfile');
      crlf++;i++;
    } else if (bytes[i]===10) bareLf++;
  }
  if (crlf && bareLf) fail('DEPENDENCY_DRIFT','mixed lockfile line endings');
  if (!crlf) return bytes;
  const canonical=Buffer.alloc(bytes.length-crlf);
  for (let source=0,target=0;source<bytes.length;source++) {
    if (bytes[source]===13) continue;
    canonical[target++]=bytes[source];
  }
  return canonical;
}
// Only npm's top-level generated lockfile has the reviewed LF/CRLF equivalence.
// All other dependency bytes, including nested lockfiles, remain exact.
function dependencyFileSha256(relative, bytes) {
  return sha(relative === '.package-lock.json' ? canonicalLockfileBytes(bytes) : bytes);
}
function validatePolicy(policy, now, context, target) {
  if (!object(policy) || policy.schemaVersion !== 2 || sha(JSON.stringify(policy)) !== BASELINE_SHA256)
    fail('POLICY_INVALID','reviewed remediation baseline changed or retired exception supplied');
  if (!['testing','production'].includes(context)) fail('CONTEXT_INVALID','explicit testing or production context required');
  if (context === 'production' && target !== PRODUCTION_TARGET)
    fail('PRODUCTION_NOT_APPROVED','explicit target cargorun-dev required; gate success does not authorize deployment');
  if (context === 'testing' && target !== undefined) fail('CONTEXT_INVALID','target applies only to production context');
  if (!Number.isFinite(now) || now < Date.parse(policy.validFromUtc)) fail('CLOCK_INVALID','before reviewed baseline');
}
function readDependencyState(root) {
  const dependencies = validateDependencies(root); // Rejects junctions, package additions, version/URL/integrity drift.
  const lockBytes = canonicalLockfileBytes(fs.readFileSync(path.join(root,'api/package-lock.json')));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const tree = dependencies.files.slice().sort().map(p => [p,dependencyFileSha256(p,fs.readFileSync(path.join(dependencies.directory,p)))]);
  return {lock,lockfileSha256:sha(lockBytes),dependencyPackages:dependencies.packages,
    dependencyFileCount:tree.length,dependencyTreeSha256:sha(JSON.stringify(tree))};
}
function validateState(policy,state) {
  if (!object(state) || state.lockfileSha256 !== policy.lockfileSha256 ||
      state.dependencyTreeSha256 !== policy.dependencyTreeSha256 ||
      state.dependencyPackages !== policy.dependencyPackages ||
      state.dependencyFileCount !== policy.dependencyFileCount) fail('DEPENDENCY_DRIFT','reviewed dependency bytes changed');
  if (!object(state.lock?.packages) || !object(state.lock.packages['']?.dependencies)) fail('DEPENDENCY_DRIFT','missing dependency graph');
  const expectedVersions = {mssql:'12.7.6',tedious:'20.3.7'};
  for (const name of SCOPED) {
    const binding=policy.packages[name], entry=state.lock.packages['node_modules/'+name];
    if (!entry || !binding || binding.path !== 'node_modules/'+name ||
        binding.version !== expectedVersions[name] || entry.version !== binding.version || entry.integrity !== binding.integrity) fail('DEPENDENCY_DRIFT','reviewed package changed');
  }
  if (!state.lock.packages['node_modules/mssql'].dependencies?.tedious ||
      Object.keys(state.lock.packages).some(p=>/(^|\/)sprintf-js$/.test(p))) fail('DEPENDENCY_DRIFT','reviewed dependency path changed');
}
function evaluateAudit(report,{policy,state,exitCode,now=Date.now(),context='production',target}) {
  validatePolicy(policy,now,context,target);
  validateState(policy,state);
  if (!object(report) || report.auditReportVersion !== 2 || own(report,'error') ||
      !object(report.vulnerabilities) || !object(report.metadata?.vulnerabilities) ||
      !object(report.metadata?.dependencies)) fail('AUDIT_INVALID','missing audit v2 evidence');
  const entries=Object.entries(report.vulnerabilities);
  const counts=Object.fromEntries(LEVELS.map(s=>[s,0]));
  const dependencyCounts=policy.auditDependencyCounts;
  for (const [key,value] of Object.entries(dependencyCounts)) if (report.metadata.dependencies[key] !== value) fail('AUDIT_INVALID','incomplete dependency coverage');
  if (![0,1].includes(exitCode) || exitCode !== (entries.length ? 1 : 0)) fail('AUDIT_INVALID','audit process status inconsistent');
  for (const [name,item] of entries) {
    if (!object(item) || item.name !== name || !LEVELS.includes(item.severity) ||
        typeof item.isDirect !== 'boolean' || typeof item.range !== 'string' || !item.range ||
        !Array.isArray(item.via) || !item.via.length || !Array.isArray(item.effects) ||
        !Array.isArray(item.nodes) || !item.nodes.length ||
        !(typeof item.fixAvailable === 'boolean' || object(item.fixAvailable))) fail('AUDIT_INVALID','incomplete vulnerability entry');
    if (object(item.fixAvailable) && (typeof item.fixAvailable.name !== 'string' || !item.fixAvailable.name ||
        typeof item.fixAvailable.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(item.fixAvailable.version) ||
        typeof item.fixAvailable.isSemVerMajor !== 'boolean')) fail('AUDIT_INVALID','incomplete fix metadata');
    if (item.isDirect !== own(state.lock.packages[''].dependencies,name)) fail('AUDIT_INVALID','direct dependency flag inconsistent');
    if (new Set(item.nodes).size !== item.nodes.length) fail('AUDIT_INVALID','duplicate package nodes');
    for (const node of item.nodes) if (!own(state.lock.packages,node) || !node.endsWith('node_modules/'+name)) fail('AUDIT_INVALID','unknown installed package path');
    for (const via of item.via) {
      if (typeof via === 'string') {
        if (!own(report.vulnerabilities,via)) fail('AUDIT_INVALID','unresolved advisory dependency');
        if (!item.nodes.some(node=>own(state.lock.packages[node].dependencies || {},via))) fail('AUDIT_INVALID','advisory edge absent from dependency graph');
        if (!report.vulnerabilities[via].effects?.includes(name)) fail('AUDIT_INVALID','missing reverse advisory edge');
      } else if (!object(via) || !Number.isInteger(via.source) || via.source <= 0 ||
          via.name !== name || via.dependency !== name || !LEVELS.includes(via.severity) ||
          typeof via.title !== 'string' || !via.title || typeof via.range !== 'string' || !via.range ||
          typeof via.url !== 'string' || !/^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(via.url)) fail('AUDIT_INVALID','advisory identity missing or invalid');
    }
    for (const affected of item.effects) if (typeof affected !== 'string' || !report.vulnerabilities[affected]?.via?.includes(name)) fail('AUDIT_INVALID','unresolved affected dependency');
    counts[item.severity]++;
  }
  for (const level of LEVELS) if (report.metadata.vulnerabilities[level] !== counts[level]) fail('AUDIT_INVALID','severity totals inconsistent');
  if (report.metadata.vulnerabilities.total !== entries.length) fail('AUDIT_INVALID','vulnerability total inconsistent');
  function leaves(name,visited=new Set()) {
    if (visited.has(name)) fail('AUDIT_INVALID','cyclic advisory graph');
    const next=new Set([...visited,name]);
    return report.vulnerabilities[name].via.flatMap(v=>typeof v === 'string' ? leaves(v,next) : [v]);
  }
  for (const [name] of entries) leaves(name); // Retain advisory graph consistency checks.
  if (entries.length) fail('UNACCEPTED_ADVISORY','no active vulnerability exception; all findings require review');
  return {ok:true,context,target:context === 'production' ? target : null,baselineId:policy.baselineId,
    exceptedAdvisory:null,affectedPackages:[],nonBlockingAdvisories:[],expiresAtUtc:null,
    productionApproval:PRODUCTION_APPROVAL,authorizesDeployment:false};
}

function parseAudit(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) fail('AUDIT_INVALID','empty audit output');
  let result;
  try {result=JSON.parse(stdout);} catch {fail('AUDIT_INVALID','audit output is not JSON');}
  // JSON.parse alone accepts duplicate keys; reject overwritten evidence.
  const stack=[];
  for(const match of stdout.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g)) {
    const token=match[0],frame=stack.at(-1);
    if(token==='{')stack.push({object:true,expectKey:true,keys:new Set()});
    else if(token==='[')stack.push({object:false});
    else if(token==='}'||token===']')stack.pop();
    else if(token===':'&&frame?.object)frame.expectKey=false;
    else if(token===','&&frame?.object)frame.expectKey=true;
    else if(token.startsWith('"')&&frame?.object&&frame.expectKey){
      const key=JSON.parse(token);
      if(frame.keys.has(key))fail('AUDIT_INVALID','duplicate JSON key');
      frame.keys.add(key);
    }
  }
  return result;
}
function runNpm(args,{cwd}) {
  // Fixed executable/arguments only. Windows .cmd needs a shell; no caller input is interpolated.
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',args,
    {cwd,encoding:'utf8',shell:process.platform === 'win32',timeout:120000,maxBuffer:8*1024*1024});
}
function collectAudit(root,runner=runNpm) {
  const version=runner(['--version'],{cwd:root});
  if (version.error || version.signal || version.status !== 0 || version.stdout?.trim() !== '11.11.0') fail('AUDIT_TOOL_ERROR','npm 11.11.0 required');
  const result=runner(['audit','--prefix','api','--omit=dev','--json','--registry=https://registry.npmjs.org'],{cwd:root});
  if (result.error || result.signal || ![0,1].includes(result.status)) fail('AUDIT_TOOL_ERROR','npm audit did not complete');
  return {report:parseAudit(result.stdout),exitCode:result.status};
}
function runGate({root=ROOT,context='production',target}={}) {
  const policy=readJson(path.join(root,'docs/dependency-security-baseline.json'));
  validatePolicy(policy,Date.now(),context,target);
  const state=readDependencyState(root);
  validateState(policy,state);
  const result=collectAudit(root);
  return evaluateAudit(result.report,{policy,state,exitCode:result.exitCode,context,target});
}
function parseGateArguments(args) {
  if (!Array.isArray(args) || args[0] !== '--context' || !['testing','production'].includes(args[1]))
    fail('CONTEXT_INVALID','explicit testing or production context required');
  if (args.length === 2) return {context:args[1]};
  if (args.length === 4 && args[1] === 'production' && args[2] === '--target') return {context:args[1],target:args[3]};
  fail('CONTEXT_INVALID','production target must be explicit and unique');
}
module.exports={PRODUCTION_TARGET,PRODUCTION_APPROVAL,parseGateArguments,validatePolicy,canonicalLockfileBytes,dependencyFileSha256,readDependencyState,validateState,evaluateAudit,parseAudit,collectAudit,runGate};
if (require.main === module) {
  try {
    console.log(JSON.stringify(runGate(parseGateArguments(process.argv.slice(2)))));
  } catch(error) {console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
