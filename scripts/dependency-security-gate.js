'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateDependencies } = require('./build-deployment-package');
const ROOT = path.resolve(__dirname, '..');
const ADVISORY = 'GHSA-hp3w-g68c-fv3c';
const URL = 'https://github.com/advisories/' + ADVISORY;
const EXPIRES = '2026-11-08T00:00:00.000Z';
const LEVELS = ['info','low','moderate','high','critical'];
const SCOPED = ['mssql','sprintf-js','tedious'];
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
function validatePolicy(policy, now, context) {
  if (!object(policy) || policy.schemaVersion !== 1 || policy.advisory !== ADVISORY ||
      policy.advisoryUrl !== URL || policy.cve !== 'CVE-2026-97058' ||
      policy.npmAdvisorySource !== 1241202 || policy.severity !== 'moderate' ||
      policy.affectedRange !== '<=1.1.3' || policy.scope !== 'testing-only' ||
      policy.productionApproval !== 'PENDING_RELEASE_OWNER_ACCEPTANCE' ||
      policy.expiresAtUtc !== EXPIRES || policy.validFromUtc !== '2026-10-08T00:00:00.000Z') fail('POLICY_INVALID','exception scope or validity changed');
  if (!['testing','production'].includes(context)) fail('CONTEXT_INVALID','explicit testing or production context required');
  if (!Number.isFinite(now) || now < Date.parse(policy.validFromUtc)) fail('CLOCK_INVALID','outside exception validity');
  if (now >= Date.parse(EXPIRES)) fail('EXCEPTION_EXPIRED','expired at ' + EXPIRES);
  if (!/^[A-F0-9]{64}$/.test(policy.lockfileSha256 || '') ||
      !/^[A-F0-9]{64}$/.test(policy.dependencyTreeSha256 || '') ||
      policy.dependencyPackages !== 74 || policy.dependencyFileCount !== 7242 ||
      !object(policy.packages) || !equal(Object.keys(policy.packages).sort(),SCOPED)) fail('POLICY_INVALID','dependency binding incomplete');
}
function readDependencyState(root) {
  const dependencies = validateDependencies(root); // Rejects junctions, package additions, version/URL/integrity drift.
  const lockBytes = canonicalLockfileBytes(fs.readFileSync(path.join(root,'api/package-lock.json')));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const tree = dependencies.files.slice().sort().map(p => [p,sha(fs.readFileSync(path.join(dependencies.directory,p)))]);
  return {lock,lockfileSha256:sha(lockBytes),dependencyPackages:dependencies.packages,
    dependencyFileCount:tree.length,dependencyTreeSha256:sha(JSON.stringify(tree))};
}
function validateState(policy,state) {
  if (!object(state) || state.lockfileSha256 !== policy.lockfileSha256 ||
      state.dependencyTreeSha256 !== policy.dependencyTreeSha256 ||
      state.dependencyPackages !== policy.dependencyPackages ||
      state.dependencyFileCount !== policy.dependencyFileCount) fail('DEPENDENCY_DRIFT','reviewed dependency bytes changed');
  if (!object(state.lock?.packages) || !object(state.lock.packages['']?.dependencies)) fail('DEPENDENCY_DRIFT','missing dependency graph');
  const expectedVersions = {mssql:'11.0.2',tedious:'18.6.2','sprintf-js':'1.1.3'};
  for (const name of SCOPED) {
    const binding=policy.packages[name], entry=state.lock.packages['node_modules/'+name];
    if (!entry || !binding || binding.path !== 'node_modules/'+name ||
        binding.version !== expectedVersions[name] || entry.version !== binding.version || entry.integrity !== binding.integrity) fail('DEPENDENCY_DRIFT','reviewed package changed');
  }
  if (!state.lock.packages['node_modules/mssql'].dependencies?.tedious ||
      !state.lock.packages['node_modules/tedious'].dependencies?.['sprintf-js']) fail('DEPENDENCY_DRIFT','reviewed dependency path changed');
}
function evaluateAudit(report,{policy,state,exitCode,now=Date.now(),context='production'}) {
  validatePolicy(policy,now,context);
  validateState(policy,state);
  if (!object(report) || report.auditReportVersion !== 2 || own(report,'error') ||
      !object(report.vulnerabilities) || !object(report.metadata?.vulnerabilities) ||
      !object(report.metadata?.dependencies)) fail('AUDIT_INVALID','missing audit v2 evidence');
  const entries=Object.entries(report.vulnerabilities);
  const counts=Object.fromEntries(LEVELS.map(s=>[s,0]));
  const dependencyCounts={prod:75,dev:0,optional:0,peer:0,peerOptional:0,total:74};
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
  const accepted=new Set(), blocked=new Set(), nonBlocking=new Set();
  for (const [name,item] of entries) {
    const direct=leaves(name);
    for (const advisory of direct) {
      const severity=Math.max(LEVELS.indexOf(item.severity),LEVELS.indexOf(advisory.severity));
      if (LEVELS.indexOf(item.severity) < LEVELS.indexOf(advisory.severity)) fail('AUDIT_INVALID','inherited severity understated');
      if (advisory.url === URL) {
        if (!SCOPED.includes(name) || advisory.source !== policy.npmAdvisorySource ||
            advisory.name !== 'sprintf-js' || advisory.dependency !== 'sprintf-js' ||
            advisory.range !== policy.affectedRange || item.severity !== 'moderate' ||
            advisory.severity !== 'moderate' ||
            !equal(item.nodes,[policy.packages[name].path]) ||
            !equal(item.fixAvailable,{name:'mssql',version:'4.2.0',isSemVerMajor:true})) fail('EXCEPTION_CHANGED','advisory exposure or fix changed; re-review required');
        accepted.add(name);
      } else if (severity >= 2 || SCOPED.includes(name)) blocked.add(advisory.url);
      else nonBlocking.add(advisory.url);
    }
  }
  if (blocked.size) fail('UNACCEPTED_ADVISORY','other or new advisory: '+[...blocked].sort().join(', '));
  if (accepted.size && !equal([...accepted].sort(),SCOPED)) fail('AUDIT_INVALID','exception dependency chain incomplete');
  if (context !== 'testing') fail('PRODUCTION_NOT_APPROVED','testing exception is not release-owner production acceptance');
  return {ok:true,context,exceptedAdvisory:accepted.size ? ADVISORY : null,affectedPackages:[...accepted].sort(),
    nonBlockingAdvisories:[...nonBlocking].sort(),expiresAtUtc:EXPIRES,productionApproval:policy.productionApproval};
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
function runGate({root=ROOT,context='production'}={}) {
  const policy=readJson(path.join(root,'docs/dependency-security-exception.json'));
  validatePolicy(policy,Date.now(),context);
  const state=readDependencyState(root);
  validateState(policy,state);
  const result=collectAudit(root);
  return evaluateAudit(result.report,{policy,state,exitCode:result.exitCode,context});
}
module.exports={validatePolicy,canonicalLockfileBytes,readDependencyState,validateState,evaluateAudit,parseAudit,collectAudit,runGate};
if (require.main === module) {
  try {
    const args=process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--context' || !['testing','production'].includes(args[1])) fail('CONTEXT_INVALID','use --context testing or --context production');
    console.log(JSON.stringify(runGate({context:args[1]})));
  } catch(error) {console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
