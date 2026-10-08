'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {parseGateArguments,evaluateAudit,parseAudit,collectAudit,validateState,canonicalLockfileBytes,dependencyFileSha256,readDependencyState}=require('../scripts/dependency-security-gate');
const {requireLinux,requireApprovedProductionResult,emitDependencyDiagnostics,runDependencyTests}=require('../scripts/validate-linux-release');
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
 assert.equal(result.productionApproval,'APPROVED_CARGORUN_LIVE_TESTING');
});
test('production context requires an explicit approved target including the default context',()=>{
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

test('Linux validator accepts only complete scoped production approval evidence',()=>{
 const approved=evaluateAudit(clone(fixture),{...options(),context:'production',target:'cargorun-dev'});
 const result={status:0,stdout:JSON.stringify(approved),stderr:''};
 assert.equal(requireApprovedProductionResult(result),true);
 for(const changed of [
  {...result,status:1},{...result,status:2},{...result,stderr:'unexpected error'},
  {...result,stdout:'not JSON'},{...result,stdout:'{}'},
  {...result,stdout:'{"ok":true,"ok":false}'},{...result,signal:'SIGTERM'},
  {...result,error:new Error('spawn failed')}
 ])assert.throws(()=>requireApprovedProductionResult(changed),/Production audit gate/);
 for(const mutate of [r=>r.ok=false,r=>r.context='testing',r=>r.target='different-app',
  r=>r.productionApproval='PENDING_RELEASE_OWNER_ACCEPTANCE',r=>r.expiresAtUtc='2027-11-08T00:00:00.000Z',
  r=>r.exceptedAdvisory='GHSA-aaaa-bbbb-cccc',r=>r.affectedPackages=[],r=>delete r.nonBlockingAdvisories]){
  const changed=clone(approved);mutate(changed);
  assert.throws(()=>requireApprovedProductionResult({...result,stdout:JSON.stringify(changed)}),/Production audit gate/);
 }
});

test('dependency diagnostics report exact sorted bytes without file contents or absolute paths',t=>{
 const os=require('node:os');
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'cargorun-diagnostic-fixture-'));
 t.after(()=>{
  const resolved=path.resolve(fixture);
  assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('cargorun-diagnostic-fixture-'));
  fs.rmSync(resolved,{recursive:true,force:true});
 });
 fs.mkdirSync(path.join(fixture,'api/node_modules/fixture-package'),{recursive:true});
 fs.mkdirSync(path.join(fixture,'docs'));
 const entry={version:'1.0.0',resolved:'https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz',integrity:'sha512-fixture'};
 const fixtureLock={lockfileVersion:3,packages:{'':{dependencies:{'fixture-package':'1.0.0'}},'node_modules/fixture-package':entry}};
 fs.writeFileSync(path.join(fixture,'api/package.json'),JSON.stringify({dependencies:{'fixture-package':'1.0.0'}}));
 fs.writeFileSync(path.join(fixture,'api/package-lock.json'),JSON.stringify(fixtureLock));
 fs.writeFileSync(path.join(fixture,'api/node_modules/fixture-package/package.json'),JSON.stringify({version:'1.0.0'}));
 fs.writeFileSync(path.join(fixture,'api/node_modules/fixture-package/private.txt'),'PRIVATE_DIAGNOSTIC_SENTINEL');
 const hidden=Buffer.from(JSON.stringify({lockfileVersion:3,packages:{'node_modules/fixture-package':entry}},null,2)+'\n');
 fs.writeFileSync(path.join(fixture,'api/node_modules/.package-lock.json'),hidden);
 const expected=readDependencyState(fixture);
 fs.writeFileSync(path.join(fixture,'docs/dependency-security-exception.json'),JSON.stringify(expected));
 const collect=()=>{
  const lines=[];
  emitDependencyDiagnostics(fixture,{write:line=>lines.push(line),runner:()=>({status:0,stdout:'11.11.0\n'})});
  const summary=JSON.parse(lines[0].slice('CARGORUN_DEPENDENCY_DIAGNOSTIC '.length));
  const files=lines.slice(1,-1).map(line=>JSON.parse(line.slice('CARGORUN_DEPENDENCY_FILE '.length)));
  assert.doesNotMatch(lines.join('\n'),/PRIVATE_DIAGNOSTIC_SENTINEL/);
  assert.ok(!lines.join('\n').includes(fixture));
  assert.equal(summary.npm,'11.11.0');assert.equal(summary.node,process.version);
  assert.deepEqual(files.map(f=>f.path),files.map(f=>f.path).sort());
  assert.deepEqual(files.map(f=>Object.keys(f)),files.map(()=>['path','sha256','fingerprintSha256']));
  assert.equal(summary.actual.dependencyFileCount,files.length);
  assert.equal(summary.actual.dependencyTreeSha256,crypto.createHash('sha256').update(JSON.stringify(files.map(f=>[f.path,f.fingerprintSha256]))).digest('hex').toUpperCase());
  assert.deepEqual(JSON.parse(lines.at(-1).slice('CARGORUN_DEPENDENCY_DIAGNOSTIC_END '.length)),{files:files.length,sha256:summary.actual.dependencyTreeSha256,rawSha256:summary.rawDependencyTreeSha256});
  return {summary,files};
 };
 const lf=collect();assert.deepEqual(lf.summary.actual,lf.summary.expected);assert.equal(lf.summary.hiddenLockfile.lineEndings.format,'LF');
 fs.writeFileSync(path.join(fixture,'api/node_modules/.package-lock.json'),Buffer.from(hidden.toString().replace(/\n/g,'\r\n')));
 const crlf=collect();assert.equal(crlf.summary.hiddenLockfile.lineEndings.format,'CRLF');
 assert.notEqual(crlf.summary.hiddenLockfile.sha256,lf.summary.hiddenLockfile.sha256);
 assert.equal(crlf.summary.actual.dependencyTreeSha256,crlf.summary.expected.dependencyTreeSha256);
 assert.notEqual(crlf.summary.rawDependencyTreeSha256,lf.summary.rawDependencyTreeSha256);
 assert.deepEqual(crlf.files.filter((f,i)=>f.sha256!==lf.files[i].sha256).map(f=>f.path),['.package-lock.json']);
 assert.equal(crlf.summary.actual.lockfileSha256,lf.summary.actual.lockfileSha256);
});

test('failed dependency test process emits diagnostics and retains its nonzero exit code',()=>{
 const calls=[];
 assert.throws(()=>runDependencyTests('fixture',{runner:(_program,args,options)=>{
  assert.deepEqual(args,['--test','--test-concurrency=1']);assert.equal(options.stdio,'inherit');return {status:17};
 },diagnose:(root,{write})=>{calls.push(root);write('diagnostic');},write:line=>calls.push(line)}),
 error=>error.exitCode===17&&error.message==='Validation step failed: Node test suite');
 assert.deepEqual(calls,['fixture','diagnostic']);
});

test('diagnostic errors cannot conceal the test failure or leak exception contents',()=>{
 const lines=[];
 assert.throws(()=>runDependencyTests('fixture',{runner:()=>({status:1}),diagnose:()=>{throw Error('PRIVATE_DIAGNOSTIC_SENTINEL');},write:line=>lines.push(line)}),
 error=>error.exitCode===1);
 assert.deepEqual(lines,['CARGORUN_DEPENDENCY_DIAGNOSTIC_ERROR {"code":"DIAGNOSTIC_UNAVAILABLE"}']);
});

test('successful tests do not emit dependency diagnostics',()=>{
 assert.doesNotThrow(()=>runDependencyTests('fixture',{runner:()=>({status:0}),diagnose:()=>assert.fail('unexpected diagnostic')}));
});

test('interrupted test processes remain failures after diagnostics',()=>{
 let emitted=0;
 assert.throws(()=>runDependencyTests('fixture',{runner:()=>({status:null,signal:'SIGTERM'}),diagnose:()=>emitted++}),error=>error.exitCode===1);
 assert.equal(emitted,1);
});

test('reviewed hidden lockfile LF and complete CRLF have the exact approved fingerprint',()=>{
 const raw=fs.readFileSync(path.join(root,'api/node_modules/.package-lock.json'));
 const lf=canonicalLockfileBytes(raw),crlf=Buffer.from(lf.toString('utf8').replace(/\n/g,'\r\n'));
 const approved='0CEDA1DCF9CCAF92466D10141442929EE8EE811DFB7DD7F93A9571373F821667';
 assert.equal(dependencyFileSha256('.package-lock.json',lf),approved);
 assert.equal(dependencyFileSha256('.package-lock.json',crlf),approved);
 const actual=readDependencyState(root);validateState(policy,actual);
 assert.equal(actual.dependencyTreeSha256,'FA20832CD500FD267124618A8D6EA8F2155B6AD461BA01ADEA1D4194DFED4A0D');
 assert.equal(actual.dependencyFileCount,7242);assert.equal(actual.dependencyPackages,74);
 assert.deepEqual(fs.readFileSync(path.join(root,'api/node_modules/.package-lock.json')),raw);
});

test('hidden lockfile mixed and bare CR endings fail before fingerprint acceptance',()=>{
 const lf=canonicalLockfileBytes(fs.readFileSync(path.join(root,'api/node_modules/.package-lock.json')));
 const mixed=Buffer.from(lf.toString('utf8').replace('\n','\r\n'));
 for(const bytes of [mixed,Buffer.concat([lf,Buffer.from('\r')])])
  assert.throws(()=>dependencyFileSha256('.package-lock.json',bytes),/DEPENDENCY_DRIFT/);
});

test('unexpected hidden lockfile content remains rejected by the installed tree binding',()=>{
 const {validateDependencies}=require('../scripts/build-deployment-package');
 const deps=validateDependencies(root),actual=readDependencyState(root);
 const tree=deps.files.slice().sort().map(p=>[p,dependencyFileSha256(p,fs.readFileSync(path.join(deps.directory,p)))]);
 const lf=canonicalLockfileBytes(fs.readFileSync(path.join(deps.directory,'.package-lock.json')));
 for(const bytes of [Buffer.concat([lf,Buffer.from(' ')]),Buffer.from(lf.toString().replace('"lockfileVersion": 3','"lockfileVersion": 2'))]){
  const altered=tree.map(([p,h])=>[p,p==='.package-lock.json'?dependencyFileSha256(p,bytes):h]);
  const changed={...actual,dependencyTreeSha256:crypto.createHash('sha256').update(JSON.stringify(altered)).digest('hex').toUpperCase()};
  assert.throws(()=>validateState(policy,changed),/DEPENDENCY_DRIFT/);
 }
});

test('all other 7241 dependency files and nested lockfiles retain raw-byte verification',()=>{
 const {validateDependencies}=require('../scripts/build-deployment-package');
 const deps=validateDependencies(root);let checked=0;
 for(const p of deps.files){if(p==='.package-lock.json')continue;
  const bytes=fs.readFileSync(path.join(deps.directory,p));
  assert.equal(dependencyFileSha256(p,bytes),crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase());checked++;
 }
 assert.equal(checked,7241);
 for(const p of ['package/index.js','package/.package-lock.json','package/package-lock.json']){
  const lf=Buffer.from('one\ntwo\n'),crlf=Buffer.from('one\r\ntwo\r\n');
  assert.notEqual(dependencyFileSha256(p,lf),dependencyFileSha256(p,crlf));
  assert.equal(dependencyFileSha256(p,crlf),crypto.createHash('sha256').update(crlf).digest('hex').toUpperCase());
 }
});

test('approved live-testing production target passes the exact advisory without granting deployment authority',()=>{
 const result=evaluateAudit(clone(fixture),{...options(),context:'production',target:'cargorun-dev'});
 assert.equal(result.ok,true);assert.equal(result.target,'cargorun-dev');
 assert.equal(result.exceptedAdvisory,'GHSA-hp3w-g68c-fv3c');
 assert.equal(result.productionApproval,'APPROVED_CARGORUN_LIVE_TESTING');
 assert.equal(policy.riskAcceptance.authorizesDeployment,false);
 assert.equal(result.expiresAtUtc,'2026-11-08T00:00:00.000Z');
});

test('missing, changed or broadened risk acceptance and unapproved targets fail closed',()=>{
 const production=()=>({...options(),context:'production',target:'cargorun-dev'});
 for(const target of [undefined,null,'','production','CARGORUN-DEV','different-app'])
  assert.throws(()=>evaluateAudit(clone(fixture),{...production(),target}),/PRODUCTION_NOT_APPROVED/);
 for(const change of [p=>delete p.riskAcceptance,p=>p.productionApproval='PENDING_RELEASE_OWNER_ACCEPTANCE',
  p=>p.riskAcceptance.targetApplication='*',p=>p.riskAcceptance.purpose='all-production',
  p=>p.riskAcceptance.acceptedByRole='unknown',p=>p.riskAcceptance.authorizesDeployment=true]){
  const opts=production();change(opts.policy);
  assert.throws(()=>evaluateAudit(clone(fixture),opts),/PRODUCTION_NOT_APPROVED/);
 }
});

test('production approval preserves advisory, expiry, evidence and dependency denials',()=>{
 const production=()=>({...options(),context:'production',target:'cargorun-dev'});
 for(const severity of ['moderate','high','critical'])
  assert.throws(()=>evaluateAudit(addFinding(clone(fixture),'debug',severity),production()),/UNACCEPTED_ADVISORY/);
 for(const name of ['mssql','tedious','sprintf-js']){
  const report=clone(fixture);report.vulnerabilities[name].via.push(advisory(name,'low'));
  assert.throws(()=>evaluateAudit(report,production()),/UNACCEPTED_ADVISORY/);
  const opts=production();opts.state.lock.packages['node_modules/'+name].version='99.0.0';
  assert.throws(()=>evaluateAudit(clone(fixture),opts),/DEPENDENCY_DRIFT/);
  const wrongPath=production();wrongPath.policy.packages[name].path='node_modules/other';
  assert.throws(()=>evaluateAudit(clone(fixture),wrongPath),/DEPENDENCY_DRIFT/);
 }
 for(const report of [null,{}, {...clone(fixture),metadata:null}])
  assert.throws(()=>evaluateAudit(report,production()),/AUDIT_INVALID/);
 for(const key of ['lockfileSha256','dependencyTreeSha256','dependencyPackages','dependencyFileCount']){
  const opts=production();opts.state[key]=typeof opts.state[key]==='number'?opts.state[key]+1:'0'.repeat(64);
  assert.throws(()=>evaluateAudit(clone(fixture),opts),/DEPENDENCY_DRIFT/);
 }
 for(const now of [Date.parse(policy.expiresAtUtc),Date.parse(policy.expiresAtUtc)+1])
  assert.throws(()=>evaluateAudit(clone(fixture),{...production(),now}),/EXCEPTION_EXPIRED/);
});

test('approved root and dependency fingerprints cannot be rebound by changing policy and state together',()=>{
 for(const key of ['lockfileSha256','dependencyTreeSha256']){
  const opts={...options(),context:'production',target:'cargorun-dev'};
  opts.policy[key]='0'.repeat(64);opts.state[key]=opts.policy[key];
  assert.throws(()=>evaluateAudit(clone(fixture),opts),/POLICY_INVALID/);
 }
});

test('gate command arguments keep production target explicit and reject extra or duplicate flags',()=>{
 assert.deepEqual(parseGateArguments(['--context','testing']),{context:'testing'});
 assert.deepEqual(parseGateArguments(['--context','production','--target','cargorun-dev']),{context:'production',target:'cargorun-dev'});
 for(const args of [[],['--context','other'],['--context','testing','--target','cargorun-dev'],
  ['--context','production','--target','cargorun-dev','--target','other'],['--context','production','--skip-integrity','true']])
  assert.throws(()=>parseGateArguments(args),/CONTEXT_INVALID/);
});
