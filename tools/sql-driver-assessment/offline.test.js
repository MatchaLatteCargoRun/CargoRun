'use strict';
// Offline assessment only: no connection is opened and no SQL is executed.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const oldRoot=process.env.CARGORUN_REVIEWED_DEPENDENCIES;
assert.ok(oldRoot,'Point to the preserved independent reviewed installation');
const current=require(path.join(root,'api/node_modules/mssql'));
const prior=require(path.join(oldRoot,'mssql'));
const oldT=require(path.join(oldRoot,'tedious')).TYPES;
const newT=require(path.join(root,'api/node_modules/tedious')).TYPES;
const lock=JSON.parse(fs.readFileSync(path.join(root,'api/package-lock.json')));
test('candidate has the intended fixed supported graph and no sprintf-js package',()=>{
 assert.equal(require(path.join(root,'api/node_modules/mssql/package.json')).version,'12.7.6');
 assert.equal(require(path.join(root,'api/node_modules/tedious/package.json')).version,'20.3.7');
 assert.equal(lock.packages['node_modules/mssql'].dependencies.tedious,'^19.2.2 || ^20.0.0');
 assert.equal(Object.keys(lock.packages).some(p=>/(^|\/)sprintf-js$/.test(p)),false);
});
const strings=[
 'Server=127.0.0.1,1433;Database=Synthetic;User Id=synthetic;Password=not-a-real-credential;Encrypt=true;TrustServerCertificate=false;',
 'Data Source=localhost;Initial Catalog=Synthetic;User ID=synthetic;Password={semi;colon};Connection Timeout=5;Request Timeout=3000;',
 'Server=localhost;Database=Synthetic;Encrypt=true;TrustServerCertificate=true;UseUTC=true;',
 'Server=localhost\\CARGORUNDEV;Database=Synthetic;Encrypt=true;'
];
for(const [i,cs] of strings.entries())test('connection-string parse compatibility '+i,()=>{
 assert.deepEqual(current.ConnectionPool.parseConnectionString(cs),prior.ConnectionPool.parseConnectionString(cs));
});
for(const stationId of [1,2])test('explicit station and flight parameter bindings '+stationId,()=>{
 const parameters=s=>new s.Request().input('StationId',s.BigInt,stationId).input('FlightId',s.BigInt,'9007199254740993').input('Actor',s.NVarChar(64),'SYNTHETIC-'+stationId).input('Body',s.NVarChar(s.MAX),'{"synthetic":true}').input('Flag',s.Bit,true).input('When',s.DateTime2(7),new Date('2026-10-15T01:02:03.456Z')).input('Optional',s.NVarChar(100),null).parameters;
 const describe=p=>Object.fromEntries(Object.entries(p).map(([k,v])=>[k,{type:v.type.declaration,value:v.value,length:v.length,scale:v.scale,io:v.io}]));
 assert.deepEqual(describe(parameters(current)),describe(parameters(prior)));
});
for(const [name,value] of [['BigInt','9007199254740993'],['Int',2],['Bit',true],['NVarChar','Auckland / Melbourne'],['Date',new Date('2026-10-15T00:00:00Z')],['DateTime2',new Date('2026-10-15T01:02:03.456Z')]])test('tedious parameter validation '+name,()=>{
 assert.deepEqual(newT[name].validate(value,undefined,{useUTC:true}),oldT[name].validate(value,undefined,{useUTC:true}));
});
test('UTC and datetime2 precision declaration remain explicit',()=>{
 for(const scale of [0,3,7])assert.equal(newT.DateTime2.declaration({scale}),oldT.DateTime2.declaration({scale}));
 assert.throws(()=>newT.DateTime2.validate('invalid',undefined,{useUTC:true}),/Invalid date/);
});
test('transaction isolation API and default remain READ_COMMITTED',()=>{
 assert.deepEqual(current.ISOLATION_LEVEL,prior.ISOLATION_LEVEL);
 const oldPool=new prior.ConnectionPool({server:'127.0.0.1'}),newPool=new current.ConnectionPool({server:'127.0.0.1'});
 assert.equal(new current.Transaction(newPool).isolationLevel,current.ISOLATION_LEVEL.READ_COMMITTED);
 assert.equal(new prior.Transaction(oldPool).isolationLevel,prior.ISOLATION_LEVEL.READ_COMMITTED);
 for(const n of ['begin','commit','rollback','request'])assert.equal(typeof new current.Transaction(newPool)[n],'function');
});
test('encryption defaults remain enabled with certificate verification',()=>{
 for(const s of [prior,current]){const c=new s.ConnectionPool({server:'127.0.0.1',database:'Synthetic'})._config();assert.equal(c.options.encrypt,true);assert.equal(c.options.trustServerCertificate,false);assert.equal(c.options.tdsVersion,'7_4');}
});
test('document the config reference breaking change without changing CargoRun',()=>{
 const a={server:'127.0.0.1'},b={server:'127.0.0.1'};
 assert.notEqual(new prior.ConnectionPool(a).config,a);
 assert.equal(new current.ConnectionPool(b).config,b);
});
const WritableTrackingBuffer=require(path.join(root,'api/node_modules/tedious/lib/tracking-buffer/writable-tracking-buffer'));
const wireCases=[
 ['DateTime2',{value:new Date('2026-10-15T01:02:03.456Z'),scale:7}],
 ['DateTime2',{value:new Date('2026-10-15T01:02:03.456Z'),scale:3}],
 ['DateTime2',{value:new Date('2026-10-15T01:02:03.456Z'),scale:0}],
 ['DateTime2',{value:null,scale:7}],
 ['Date',{value:new Date('2026-09-26T14:00:00Z')}],
 ['BigInt',{value:9007199254740993n}],
 ['BigInt',{value:null}],
 ['Int',{value:2}]
];
for(const [i,[name,parameter]] of wireCases.entries())test('actual TDS parameter bytes match reviewed driver '+name+' '+i,()=>{
 const opts={useUTC:true},a=oldT[name],b=newT[name];
 const expected=Buffer.concat([a.generateParameterLength(parameter,opts),...a.generateParameterData(parameter,opts)]);
 const buffer=new WritableTrackingBuffer();b.writeValue(buffer,parameter,opts);
 assert.deepEqual(buffer.data,expected);
 const info=new WritableTrackingBuffer();b.writeTypeInfo(info,parameter,opts);
 assert.deepEqual(info.data,a.generateTypeInfo(parameter,opts));
});
