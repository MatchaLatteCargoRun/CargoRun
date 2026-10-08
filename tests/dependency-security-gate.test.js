'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {evaluateAudit,parseAudit,collectAudit,validateState,canonicalLockfileBytes,readDependencyState}=require('../scripts/dependency-security-gate');
const {requireLinux,requireProductionDenial}=require('../scripts/validate-linux-release');
const root=path.resolve(__dirname,'..');
const policy=JSON.parse(fs.readFileSync(path.join(root,'docs/dependency-security-exception.json'),'utf8'));
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/dependency-audit-reviewed.json'),'utf8'));
const lock=JSON.parse(fs.readFileSync(path.join(root,'api/package-lock.json'),'utf8'));
const state={lock,lockfileSha256:policy.lockfileSha256,dependencyTreeSha256:policy.dependencyTreeSha256,
 dependencyFileCount:policy.dependencyFileCount,dependencyPackages:policy.dependencyPackages};
const clone=value=>structuredClone(value);
const options=()=>({policy:clone(policy),state:clone(state),exitCode:1,now:Date.parse('2026-10-08T12:00:00Z'),context:'testing'});
function totals(report){
 const counts={info:0,low:0,moderate:0,high:0,critical:0,total:0};
 for(const value of Object.values(report.vulnerabilities)){counts[value.severity]++;counts.total++;}
 report.metadata.vulnerabilities=counts;return report;
}
function advisory(name='debug',severity='moderate'){
 return {source:9999999,name,dependency:name,title:'Unaccepted advisory',url:'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',severity,range:'*'};
}
function addFinding(report,name='debug',severity='moderate'){
 report.vulnerabilities[name]={name,isDirect:false,severity,range:'*',nodes:['node_modules/'+name],
  via:[advisory(name,severity)],effects:[],fixAvailable:false};return totals(report);
}
test('only the reviewed advisory and its exact three-package chain are excepted for testing',()=>{
 const result=evaluateAudit(clone(fixture),options());
 assert.equal(result.exceptedAdvisory,'GHSA-hp3w-g68c-fv3c');
 assert.deepEqual(result.affectedPackages,['mssql','sprintf-js','tedious']);
 assert.equal(result.productionApproval,'PENDING_RELEASE_OWNER_ACCEPTANCE');
});
test('production context remains blocked and is the default',()=>{
 for(const context of ['production',undefined]){
  const opts=options();delete opts.context;if(context)opts.context=context;
  assert.throws(()=>evaluateAudit(clone(fixture),opts),/PRODUCTION_NOT_APPROVED/);
 }
});
test('expiry rejects the exact boundary and later times; one millisecond before is valid',()=>{
 const opts=options();opts.now=Date.parse(policy.expiresAtUtc)-1;
 assert.equal(evaluateAudit(clone(fixture),opts).ok,true);
 for(const now of [Date.parse(policy.expiresAtUtc),Date.parse(policy.expiresAtUtc)+1]){
  assert.throws(()=>evaluateAudit(clone(fixture),{...opts,now}),/EXCEPTION_EXPIRED/);
 }
});
test('invalid clocks and extended expiry cannot grant an exception',()=>{
 for(const now of [NaN,Infinity,Date.parse(policy.validFromUtc)-1])assert.throws(()=>evaluateAudit(clone(fixture),{...options(),now}),/CLOCK_INVALID/);
 const opts=options();opts.policy.expiresAtUtc='2027-11-08T00:00:00.000Z';
 assert.throws(()=>evaluateAudit(clone(fixture),opts),/POLICY_INVALID/);
});
for(const severity of ['moderate','high','critical']){
 test('unrelated '+severity+' advisories remain blocking beside the exception',()=>{
  assert.throws(()=>evaluateAudit(addFinding(clone(fixture),'debug',severity),options()),/UNACCEPTED_ADVISORY/);
 });
}
test('unrelated low advisories remain visible but do not change the moderate threshold',()=>{
 const result=evaluateAudit(addFinding(clone(fixture),'debug','low'),options());
 assert.equal(result.ok,true);
 assert.deepEqual(result.nonBlockingAdvisories,['https://github.com/advisories/GHSA-aaaa-bbbb-cccc']);
});
for(const name of ['mssql','tedious','sprintf-js']){
 test('a new advisory on '+name+' cannot inherit the exception even at low severity',()=>{
  const report=clone(fixture);report.vulnerabilities[name].via.push(advisory(name,'low'));
  assert.throws(()=>evaluateAudit(report,options()),/UNACCEPTED_ADVISORY/);
 });
}
test('changed advisory identity, URL, severity, range or fix requires re-review',()=>{
 for(const change of [
  via=>via.source++,via=>via.url+='?ignored',via=>via.severity='high',via=>via.range='*',
  via=>via.name='mssql',via=>via.dependency='mssql'
 ]){
  const report=clone(fixture);change(report.vulnerabilities['sprintf-js'].via[0]);
  assert.throws(()=>evaluateAudit(report,options()),/AUDIT_INVALID|EXCEPTION_CHANGED/);
 }
 const report=clone(fixture);report.vulnerabilities['sprintf-js'].fixAvailable=true;
 assert.throws(()=>evaluateAudit(report,options()),/EXCEPTION_CHANGED/);
});
test('removing inherited vulnerability rows cannot make an incomplete chain acceptable',()=>{
 const report=clone(fixture);
 delete report.vulnerabilities.mssql;report.vulnerabilities.tedious.effects=[];totals(report);
 assert.throws(()=>evaluateAudit(report,options()),/AUDIT_INVALID/);
});
test('dangling and cyclic advisory references fail closed',()=>{
 for(const via of ['missing','mssql']){
  const report=clone(fixture);report.vulnerabilities.mssql.via=[via];
  assert.throws(()=>evaluateAudit(report,options()),/AUDIT_INVALID/);
 }
});
test('missing, invalid and understated audit metadata fails closed',()=>{
 for(const change of [
  r=>delete r.auditReportVersion,r=>r.auditReportVersion=1,r=>delete r.metadata,
  r=>delete r.metadata.dependencies.prod,r=>r.metadata.dependencies.total=73,
  r=>r.metadata.vulnerabilities.total=0,r=>r.metadata.vulnerabilities.moderate=0,
  r=>r.error={code:'E401'},r=>r.vulnerabilities.mssql.severity='low',
  r=>r.vulnerabilities.mssql.nodes=[],r=>r.vulnerabilities.mssql.via=[],
  r=>delete r.vulnerabilities.mssql.isDirect,r=>delete r.vulnerabilities.mssql.effects,
  r=>r.vulnerabilities.mssql.fixAvailable={},
  r=>r.vulnerabilities.mssql.nodes=['node_modules/not-installed']
 ]){
  const report=clone(fixture);change(report);
  assert.throws(()=>evaluateAudit(report,options()),/AUDIT_INVALID/);
 }
 for(const report of [null,[],{},false])assert.throws(()=>evaluateAudit(report,options()),/AUDIT_INVALID/);
});
test('audit exit status must agree with complete vulnerability evidence',()=>{
 for(const exitCode of [0,2,null,undefined])assert.throws(()=>evaluateAudit(clone(fixture),{...options(),exitCode}),/AUDIT_INVALID/);
 const clean=totals({...clone(fixture),vulnerabilities:{}});
 assert.equal(evaluateAudit(clean,{...options(),exitCode:0}).exceptedAdvisory,null);
 assert.throws(()=>evaluateAudit(clean,options()),/AUDIT_INVALID/);
});
test('empty, truncated, noisy and duplicate-key JSON is rejected',()=>{
 for(const value of ['', ' ', '{', 'warning\n{}','{"a":1,"a":2}','{"x":{"a":1,"\\u0061":2}}']){
  assert.throws(()=>parseAudit(value),/AUDIT_INVALID/);
 }
 assert.deepEqual(parseAudit(JSON.stringify(fixture)),fixture);
 assert.deepEqual(parseAudit('{"a":[{"x":1},{"x":2}],"b":"{ \\"x\\": \\"y\\" }"}'),{a:[{x:1},{x:2}],b:'{ "x": "y" }'});
});
test('npm tool errors, signals, wrong versions and incomplete output fail closed',()=>{
 const version={status:0,stdout:'11.11.0\n'};
 for(const result of [{status:2,stdout:'{}'},{status:1,error:new Error('network')},{status:1,signal:'SIGTERM'},{status:1,stdout:'partial'}]){
  let call=0;assert.throws(()=>collectAudit(root,()=>call++?result:version),/AUDIT_TOOL_ERROR|AUDIT_INVALID/);
 }
 assert.throws(()=>collectAudit(root,()=>({status:0,stdout:'12.0.0'})),/AUDIT_TOOL_ERROR/);
 const calls=[];
 const result=collectAudit(root,(args)=>{calls.push(args);return calls.length===1?version:{status:1,stdout:JSON.stringify(fixture)};});
 assert.equal(result.exitCode,1);
 assert.deepEqual(calls[1],['audit','--prefix','api','--omit=dev','--json','--registry=https://registry.npmjs.org']);
});
test('lockfile, installed bytes, file count, package count and package versions are bound',()=>{
 for(const key of ['lockfileSha256','dependencyTreeSha256','dependencyFileCount','dependencyPackages']){
  const changed=clone(state);changed[key]=typeof changed[key]==='number'?changed[key]+1:'0'.repeat(64);
  assert.throws(()=>validateState(policy,changed),/DEPENDENCY_DRIFT/);
 }
 for(const name of ['mssql','tedious','sprintf-js']){
  const changed=clone(state);changed.lock.packages['node_modules/'+name].version='99.0.0';
  assert.throws(()=>validateState(policy,changed),/DEPENDENCY_DRIFT/);
 }
});
test('reviewed Git LF lockfile is the authoritative testing identity',()=>{
 const raw=fs.readFileSync(path.join(root,'api/package-lock.json'));
 const canonical=canonicalLockfileBytes(raw);
 const digest=crypto.createHash('sha256').update(canonical).digest('hex').toUpperCase();
 assert.equal(digest,policy.lockfileSha256);
 assert.equal(policy.lockfileSha256,'2EF5A6BC5F9D74714B9F4FDEDD427840075E825441FEE6DC9F337CD9549E0EE6');
});
test('equivalent full CRLF worktree lockfile is accepted without changing the Git identity',()=>{
 const raw=fs.readFileSync(path.join(root,'api/package-lock.json'));
 const lf=canonicalLockfileBytes(raw);
 const crlf=Buffer.from(lf.toString('utf8').replace(/\n/g,'\r\n'),'utf8');
 assert.ok(crlf.length>lf.length);
 assert.deepEqual(canonicalLockfileBytes(crlf),lf);
 assert.equal(crypto.createHash('sha256').update(canonicalLockfileBytes(crlf)).digest('hex').toUpperCase(),policy.lockfileSha256);
});
test('mixed, bare-CR and changed lockfile bytes fail closed',()=>{
 const lf=canonicalLockfileBytes(fs.readFileSync(path.join(root,'api/package-lock.json')));
 const mixed=Buffer.from(lf.toString('utf8').replace('\n','\r\n'),'utf8');
 for(const bytes of [mixed,Buffer.concat([lf,Buffer.from('\r')])])
  assert.throws(()=>canonicalLockfileBytes(bytes),/DEPENDENCY_DRIFT/);
 for(const bytes of [Buffer.concat([lf,Buffer.from(' ')]),Buffer.from(lf.toString('utf8').replace('"lockfileVersion": 3','"lockfileVersion": 2'),'utf8')]){
  const changed=clone(state);
  changed.lockfileSha256=crypto.createHash('sha256').update(canonicalLockfileBytes(bytes)).digest('hex').toUpperCase();
  assert.notEqual(changed.lockfileSha256,policy.lockfileSha256);
  assert.throws(()=>validateState(policy,changed),/DEPENDENCY_DRIFT/);
 }
});
test('actual independent installed dependency bytes match the exception',()=>{
 validateState(policy,readDependencyState(root));
});
test('precision syntax in a data argument is not interpreted as a format string',()=>{
 const sprintf=require('../api/node_modules/sprintf-js').sprintf;
 assert.equal(sprintf('%s','%.101f'),'%.101f');
 assert.throws(()=>sprintf('%.101f',1),RangeError);
});
test('reviewed driver format calls remain literal and CargoRun does not import sprintf-js directly',()=>{
 let count=0;
 for(const entry of policy.reviewedCalls){
  const source=fs.readFileSync(path.join(root,'api',entry.path),'utf8');
  const all=[...source.matchAll(/\(0, _sprintfJs\.sprintf\)\(/g)];
  const literals=[...source.matchAll(/\(0, _sprintfJs\.sprintf\)\((['"])(.*?)\1/g)];
  assert.equal(all.length,literals.length);assert.equal(all.length,entry.literalFormatCalls);count+=all.length;
 }
 assert.equal(count,12);
 const list=JSON.parse(fs.readFileSync(path.join(root,'scripts/deployment-allowlist.json'),'utf8'));
 for(const file of list.api.filter(p=>p.endsWith('.js')))assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'),/require\s*\(\s*['"]sprintf-js['"]/);
});
test('Linux validator rejects Windows or a different runtime before any install',()=>{
 assert.throws(()=>requireLinux('win32','v22.23.3'),/approved Linux/);
 assert.throws(()=>requireLinux('linux','v20.0.0'),/approved Linux/);
 assert.doesNotThrow(()=>requireLinux('linux','v22.23.3'));
 const source=fs.readFileSync(path.join(root,'scripts/validate-linux-release.js'),'utf8');
 assert.doesNotMatch(source,/static-web-apps-deploy|az login|git push/);
 assert.match(source,/scripts\/dependency-security-gate\.js','--context','production'/);
});

test('Linux validator accepts only the exact production gate denial',()=>{
 const expected=JSON.stringify({ok:false,error:'PRODUCTION_NOT_APPROVED: testing exception is not release-owner production acceptance'});
 assert.equal(requireProductionDenial({status:1,stdout:'',stderr:expected}),true);
 for(const result of [
  {status:0,stdout:'',stderr:expected},
  {status:2,stdout:'',stderr:expected},
  {status:1,stdout:'unexpected success',stderr:expected},
  {status:1,stdout:'',stderr:'{"ok":false,"error":"AUDIT_INVALID: incomplete report"}'},
  {status:1,stdout:'',stderr:'not JSON'},
  {status:1,stdout:'',stderr:expected,signal:'SIGTERM'},
  {status:1,stdout:'',stderr:expected,error:new Error('spawn failed')}
 ])assert.throws(()=>requireProductionDenial(result),/Production audit gate/);
});