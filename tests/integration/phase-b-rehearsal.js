'use strict';

// EXPLICITLY INVOKED ONLY. Never part of tests/*.test.js.
// This writes only to an operator-designated disposable Azure SQL copy.
// Read migrations/phase-b-rehearsal.md before supplying the acknowledgement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const mode = process.argv[2];
const env = process.env;
const quote = name => `[${String(name).replace(/]/g, ']]')}]`;
const optionsSql = `SELECT DB_NAME() AS DbName, @@SPID AS Spid,
  SESSIONPROPERTY('ANSI_NULLS') AS ANSI_NULLS,
  SESSIONPROPERTY('ANSI_PADDING') AS ANSI_PADDING,
  SESSIONPROPERTY('ANSI_WARNINGS') AS ANSI_WARNINGS,
  SESSIONPROPERTY('ARITHABORT') AS ARITHABORT,
  SESSIONPROPERTY('CONCAT_NULL_YIELDS_NULL') AS CONCAT_NULL_YIELDS_NULL,
  SESSIONPROPERTY('QUOTED_IDENTIFIER') AS QUOTED_IDENTIFIER,
  SESSIONPROPERTY('NUMERIC_ROUNDABORT') AS NUMERIC_ROUNDABORT;`;

async function main() {
  assert.ok(['migration', 'application'].includes(mode), 'Specify migration or application mode');
  assert.equal(env.CARGORUN_PHASE_B_ACK, 'ISOLATED_DATABASE_ONLY', 'Missing isolated-only acknowledgement');
  assert.equal(process.versions.node.split('.')[0], '22', 'Run the rehearsal under Node 22');
  const connectionString = env.CARGORUN_TEST_SQL_CONNECTION;
  const database = env.CARGORUN_TEST_DATABASE;
  const server = env.CARGORUN_TEST_SERVER;
  assert.ok(connectionString && server && database, 'Supply TEST connection, server, and database variables');
  assert.match(database, /^CargoRun_PhaseB_Rehearsal_[A-Za-z0-9_]+$/i, 'Use a clearly named disposable copy');
  // No fallback to DATABASE_CONNECTION_STRING and no probing of production.
  const apiRequire = createRequire(path.join(root, 'api/package.json'));
  const sql = apiRequire('mssql');
  const pool = new sql.ConnectionPool(connectionString);
  assert.equal(pool.config.server.toLowerCase(), server.toLowerCase(), 'Connection server differs from allowlist');
  assert.equal(pool.config.options?.database || pool.config.database, database, 'Connection database differs from allowlist');
  assert.notEqual(pool.config.options?.fallbackToDefaultDb, true, 'Database fallback must be disabled');
  const oldConnection = env.DATABASE_CONNECTION_STRING;
  let restoreInstrumentation = () => {};
  try {
    await pool.connect();
    const actual = (await pool.request().query(optionsSql)).recordset[0];
    assert.equal(actual.DbName, database);
    console.log('RUNTIME', process.version, 'MSSQL', apiRequire('mssql/package.json').version);
    console.log('TARGET', server, database);
    const query = async text => (await pool.request().query(text)).recordset;
    const pass = label => console.log('PASS', label);
    const snapshot = async (table, where = '1=1', omit = []) => {
      const columns = await query(`SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.${table}') ORDER BY column_id;`);
      const projection = columns.filter(c => !omit.includes(c.name)).map(c => quote(c.name)).join(',');
      const order = table === 'Offloads' ? ' ORDER BY OffloadId'
        : table === 'ExportCompletionRecords' ? ' ORDER BY ExportCompletionRecordId' : '';
      return (await query(`SELECT (SELECT ${projection} FROM dbo.${table} WHERE ${where}${order} FOR JSON PATH, INCLUDE_NULL_VALUES) AS Evidence;`))[0].Evidence;
    };
    const schema = async () => JSON.stringify(await query(`
      SELECT 'COLUMN' AS Kind,OBJECT_NAME(object_id) AS TableName,name,CONVERT(nvarchar(max),column_id) AS Detail
      FROM sys.columns WHERE object_id IN (OBJECT_ID('dbo.Offloads'),OBJECT_ID('dbo.ULDs'))
      UNION ALL SELECT 'CONSTRAINT',OBJECT_NAME(parent_object_id),name,OBJECT_DEFINITION(object_id)
      FROM sys.objects WHERE parent_object_id IN (OBJECT_ID('dbo.Offloads'),OBJECT_ID('dbo.ULDs'))
      UNION ALL SELECT 'INDEX',OBJECT_NAME(object_id),name,filter_definition
      FROM sys.indexes WHERE object_id IN (OBJECT_ID('dbo.Offloads'),OBJECT_ID('dbo.ULDs'))
      ORDER BY Kind,TableName,name;`));
    if (mode === 'migration') {
      const migration = fs.readFileSync(path.join(root, 'migrations/phase-b-offload-identity.sql'), 'utf8');
      const amendmentMigration = fs.readFileSync(path.join(root, 'migrations/export-completion-amendments.sql'), 'utf8');
      assert.equal((await query("SELECT COL_LENGTH('dbo.Offloads','UldId') AS Size;"))[0].Size, null, 'Start with an unmigrated copy');
      const before = await snapshot('Offloads');
      const completionsBefore = await snapshot('ExportCompletionRecords');
      const beforeSchema = await schema();
      // Both faults and the migration execute on the same session/batch. The
      // migration's CATCH must roll back the outer fault transaction as well.
      for (const [label, fault, expected] of [
        ['preflight failure', 'ALTER TABLE dbo.Offloads ADD UldId bigint NULL;', /UldId already exists/],
        ['late DDL collision', 'ALTER TABLE dbo.Offloads ADD CONSTRAINT FK_Offloads_FlightUld CHECK (1=1);', /FK_Offloads_FlightUld/]
      ]) {
        let error;
        try { await pool.request().batch(`BEGIN TRANSACTION; ${fault}\n${migration}`); }
        catch (err) { error = err; }
        assert.ok(error, `${label} must fail`);
        const messages = [error.message, ...(error.precedingErrors || []).map(e => e.message)].join(' ');
        assert.match(messages, expected);
        assert.equal(await schema(), beforeSchema, `${label}: no partial schema`);
        assert.equal(await snapshot('Offloads'), before, `${label}: no data changes`);
        pass(label + ' rolls back schema and preserves data');
      }
      await pool.request().batch(migration);
      assert.equal(await snapshot('Offloads', '1=1', ['UldId']), before, 'Every pre-existing column must be identical');
      assert.equal((await query('SELECT COUNT(*) AS N FROM dbo.Offloads WHERE UldId IS NOT NULL;'))[0].N, 0);
      const legacy = await query('SELECT OffloadId,FlightId,UldId,UldNumber,OffloadStatus FROM dbo.Offloads WHERE OffloadId IN (9,12) ORDER BY OffloadId;');
      assert.equal(legacy[0].OffloadStatus, 'REQUESTED');
      assert.equal(legacy[0].FlightId, null);
      assert.equal(String(legacy[1].FlightId), '25');
      assert.equal(legacy[1].UldNumber, 'AKE88888CX');
      assert.equal(legacy[1].OffloadStatus, 'COMPLETE');
      const verification = await pool.request().batch(fs.readFileSync(path.join(root, 'migrations/phase-b-verify.sql'), 'utf8'));
      console.log('VERIFICATION', JSON.stringify(verification.recordsets, null, 2));
      assert.ok(verification.recordsets.slice(-3).every(rows => rows.length === 0));
      const checks = await query(`SELECT name,is_disabled,is_not_trusted FROM sys.check_constraints
        WHERE parent_object_id=OBJECT_ID('dbo.Offloads') AND name IN ('CK_Offloads_UldId_LegacyAllowance','CK_Offloads_UldRequiresFlight')
        UNION ALL SELECT name,is_disabled,is_not_trusted FROM sys.foreign_keys
        WHERE parent_object_id=OBJECT_ID('dbo.Offloads') AND name='FK_Offloads_FlightUld';`);
      assert.equal(checks.length, 3);
      assert.ok(checks.every(c => !c.is_disabled && !c.is_not_trusted));
      const indexes = await query(`SELECT is_unique,is_disabled,has_filter,filter_definition FROM sys.indexes
        WHERE object_id=OBJECT_ID('dbo.Offloads') AND name='UX_Offloads_ActiveFlightUld';`);
      assert.equal(indexes.length, 1);
      assert.ok(indexes[0].is_unique && !indexes[0].is_disabled && indexes[0].has_filter);
      await pool.request().batch(amendmentMigration);
      assert.equal(await snapshot('Offloads'), before, 'Amendment migration must not change offload data');
      assert.equal(await snapshot('ExportCompletionRecords'), completionsBefore, 'Amendment migration must not rewrite V1 records');
      assert.equal(Number((await query('SELECT COUNT_BIG(*) AS N FROM dbo.ExportCompletionAmendments;'))[0].N), 0);
      const amendmentVerification = await pool.request().batch(fs.readFileSync(path.join(root, 'migrations/export-completion-amendments-verify.sql'), 'utf8'));
      console.log('AMENDMENT VERIFICATION', JSON.stringify(amendmentVerification.recordsets, null, 2));
      assert.ok(amendmentVerification.recordsets.slice(-4).every(rows => rows.length === 0));
      const immutableTrigger = await query(`SELECT is_disabled FROM sys.triggers
        WHERE parent_id=OBJECT_ID('dbo.ExportCompletionAmendments')
          AND name='TR_ExportCompletionAmendments_Immutable';`);
      assert.equal(immutableTrigger.length, 1);
      assert.equal(immutableTrigger[0].is_disabled, false);
      pass('identity and amendment migrations, verification, immutable V1, trusted constraints, and exact historical preservation');
      return;
    }

    assert.equal((await query("SELECT COL_LENGTH('dbo.Offloads','UldId') AS Size;"))[0].Size, 8, 'Apply the migration rehearsal first');
    assert.notEqual((await query("SELECT OBJECT_ID('dbo.ExportCompletionAmendments','U') AS Id;"))[0].Id, null, 'Apply the amendment migration rehearsal first');
    const flightId = env.CARGORUN_TEST_FLIGHT_ID;
    const uldId = env.CARGORUN_TEST_ULD_ID;
    assert.match(flightId || '', /^[1-9]\d*$/);
    assert.match(uldId || '', /^[1-9]\d*$/);
    const selected = (await pool.request().input('F', sql.BigInt, flightId).input('U', sql.BigInt, uldId).query(`
      SELECT u.UldNumber FROM dbo.ULDs u JOIN dbo.Flights f ON f.FlightId=u.FlightId
      WHERE u.FlightId=@F AND u.UldId=@U AND f.Direction='EXPORT'
        AND f.FlightStatus IN ('ACTIVE','CLOSED','FINALISED','FINALIZED');`)).recordset;
    assert.equal(selected.length, 1, 'Choose one real eligible flight/ULD in the copy');
    const { normalizeUldNumber } = apiRequire('./shared/uld');
    const body = { flightId, uldId, uldNumber: normalizeUldNumber(selected[0].UldNumber), parkingBay: 'REHEARSAL', requestInstruction: 'ISOLATED TEST ONLY' };
    const state = async () => (await pool.request().input('F', sql.BigInt, flightId).input('U', sql.BigInt, uldId).query(`
      SELECT (SELECT COUNT(*) FROM dbo.Offloads WHERE FlightId=@F AND UldId=@U AND OffloadStatus IN ('REQUESTED','TRANSIT')) AS Active,
        (SELECT COUNT_BIG(*) FROM dbo.Offloads) AS Offloads,
        (SELECT COUNT_BIG(*) FROM dbo.AuditEvents) AS Audits,
        (SELECT COUNT_BIG(*) FROM dbo.ExportCompletionAmendments WHERE FlightId=@F) AS Amendments;`)).recordset[0];
    assert.equal((await state()).Active, 0, 'Use a pair without active offloads; do not delete records to make this pass');
    const history12 = await snapshot('Offloads', 'OffloadId=12');
    const originalBegin = sql.Transaction.prototype.begin;
    const observed = [];
    let lockTimeout = null;
    const assertOptions = row => {
      assert.equal(row.DbName, database);
      for (const name of ['ANSI_NULLS','ANSI_PADDING','ANSI_WARNINGS','ARITHABORT','CONCAT_NULL_YIELDS_NULL','QUOTED_IDENTIFIER']) assert.equal(row[name], 1, name);
      assert.equal(row.NUMERIC_ROUNDABORT, 0);
    };
    // Observes the ACTUAL transaction's pinned SQL connection. It does not
    // replace SQL, serialize requests, alter isolation, or initialize SET options.
    sql.Transaction.prototype.begin = async function (...args) {
      const result = await originalBegin.apply(this, args);
      try {
        const row = (await new sql.Request(this).query(optionsSql)).recordset[0];
        assertOptions(row);
        observed.push(row);
        if (lockTimeout !== null) await new sql.Request(this).query(`SET LOCK_TIMEOUT ${lockTimeout};`);
      } catch (error) { await this.rollback(); throw error; }
      return result;
    };
    restoreInstrumentation = () => { sql.Transaction.prototype.begin = originalBegin; };
    env.DATABASE_CONNECTION_STRING = connectionString;
    const handler = apiRequire('./offloads');
    const call = async (method, payload, actor = 'Phase B Rehearsal') => {
      const errors = [];
      const context = { log: { error: (...args) => { for (const a of args) if (a instanceof Error) errors.push({ number: a.number, code: a.code }); } } };
      const principal = Buffer.from(JSON.stringify({ userRoles: ['authenticated'], userDetails: actor, userId: 'phase-b-isolated-rehearsal' })).toString('base64');
      await handler(context, { method, body: payload, headers: { 'x-ms-client-principal': principal } });
      return { status: context.res.status, body: JSON.parse(context.res.body), errors };
    };
    const blocker = new sql.Transaction(pool);
    // Use original begin so this administrative connection is not counted as an app session.
    const holdFlight = async () => {
      await originalBegin.call(blocker);
      const row = (await new sql.Request(blocker).input('F', sql.BigInt, flightId).query(`SELECT @@SPID AS Spid,FlightId FROM dbo.Flights WITH (UPDLOCK,HOLDLOCK) WHERE FlightId=@F;`)).recordset[0];
      return row.Spid;
    };
    const beforeConcurrent = await state();
    const blockerId = await holdFlight();
    let requests;
    try {
      requests = [call('POST', body), call('POST', body)];
      const deadline = Date.now() + 8000;
      let waiters = [];
      while (Date.now() < deadline) {
        waiters = (await pool.request().input('B', sql.Int, blockerId).query(`SELECT session_id,wait_type FROM sys.dm_exec_requests WHERE blocking_session_id=@B AND wait_type LIKE 'LCK%';`)).recordset;
        if (waiters.length >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const applicationSpids = new Set(observed.map(row => row.Spid));
      assert.equal(applicationSpids.size, 2, 'Two independent application SQL connections');
      assert.equal(waiters.filter(row => applicationSpids.has(row.session_id)).length, 2, 'Both real requests must contend on the held flight lock');
      console.log('BLOCKED APPLICATION SESSIONS', waiters);
    } finally {
      await blocker.rollback();
      if (requests) await Promise.allSettled(requests);
    }
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map(r => r.status).sort(), [201,409]);
    const created = responses.find(r => r.status === 201).body.offload;
    const duplicate = responses.find(r => r.status === 409).body;
    assert.equal(duplicate.code, 'ACTIVE_OFFLOAD_EXISTS');
    assert.equal(String(duplicate.offloadId), String(created.offloadId));
    const afterConcurrent = await state();
    assert.equal(afterConcurrent.Active, 1);
    assert.equal(Number(afterConcurrent.Offloads), Number(beforeConcurrent.Offloads) + 1);
    assert.equal(Number(afterConcurrent.Audits), Number(beforeConcurrent.Audits) + 1);
    console.log('ACTUAL APPLICATION SESSION OPTIONS', observed);
    pass('two blocked independent connections: one success, one exact-ID conflict, one row and one audit');

    const transition = (id, from, to) => call('PATCH', { offloadId: String(id), expectedCurrentStatus: from, nextStatus: to, deliveredLocation: 'ISOLATED TEST' });
    assert.equal((await transition(created.offloadId, 'REQUESTED', 'TRANSIT')).status, 200);
    const beforeStale = await state();
    assert.equal((await transition(created.offloadId, 'REQUESTED', 'TRANSIT')).body.code, 'STALE_STATUS');
    assert.deepEqual(await state(), beforeStale);
    assert.equal((await transition(created.offloadId, 'TRANSIT', 'COMPLETE')).status, 200);
    pass('normal transitions and stale rejection without extra audit');

    // Test DB constraints directly inside throwaway transactions. Clone required
    // fields from the NEW test record, never edit or clone historical evidence.
    const cols = await query(`SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Offloads') AND is_identity=0 AND is_computed=0 AND system_type_id<>189 ORDER BY column_id;`);
    const directInsert = async (changes, expectedConstraint = null) => {
      const tx = new sql.Transaction(pool);
      await originalBegin.call(tx);
      let error;
      try {
        const names = cols.filter(c => !(c.name === 'UldId' && changes.omitUld)).map(c => c.name);
        const expressions = names.map(name => changes[name] ?? quote(name));
        await new sql.Request(tx).input('Source', sql.BigInt, created.offloadId).query(`INSERT INTO dbo.Offloads (${names.map(quote)}) SELECT ${expressions} FROM dbo.Offloads WHERE OffloadId=@Source;`);
      } catch (err) { error = err; }
      finally { await tx.rollback(); }
      if (expectedConstraint) {
        assert.ok(error, 'Expected database rejection: ' + expectedConstraint);
        assert.match(error.message, new RegExp(expectedConstraint));
        assert.ok([547,2601,2627].includes(error.number));
      } else if (error) throw error;
    };
    await directInsert({ omitUld: true }, 'CK_Offloads_UldId_LegacyAllowance');
    await directInsert({ FlightId: 'NULL' }, 'CK_Offloads_UldRequiresFlight');
    const otherFlights = await query(`SELECT CONVERT(varchar(20),FlightId) AS Id FROM dbo.Flights WHERE FlightId<>${flightId} ORDER BY FlightId;`);
    assert.ok(otherFlights.length, 'Need another existing flight for wrong-owner test');
    await directInsert({ FlightId: otherFlights[0].Id }, 'FK_Offloads_FlightUld');
    await directInsert({ OffloadStatus: "'REQUESTED'" });
    const second = await call('POST', body);
    assert.equal(second.status, 201);
    await directInsert({ OffloadStatus: "'REQUESTED'" }, 'UX_Offloads_ActiveFlightUld');
    await directInsert({ OffloadStatus: "'TRANSIT'" }, 'UX_Offloads_ActiveFlightUld');
    assert.equal((await transition(second.body.offload.offloadId, 'REQUESTED', 'TRANSIT')).status, 200);
    await directInsert({ OffloadStatus: "'REQUESTED'" }, 'UX_Offloads_ActiveFlightUld');
    await directInsert({ OffloadStatus: "'COMPLETE'" });
    assert.equal((await transition(second.body.offload.offloadId, 'TRANSIT', 'COMPLETE')).status, 200);
    pass('legacy NULL CHECK, ownership CHECK/FK, REQUESTED/TRANSIT uniqueness, COMPLETE exclusion');

    const beforeTimeout = await state();
    await holdFlight();
    let timedOut;
    try { lockTimeout = 800; timedOut = await call('POST', body); }
    finally { lockTimeout = null; await blocker.rollback(); }
    assert.equal(timedOut.status, 500);
    assert.ok(timedOut.errors.some(e => e.number === 1222), 'Must observe SQL lock timeout, not an unrelated error');
    assert.deepEqual(await state(), beforeTimeout);
    pass('real SQL lock timeout 1222: failure, no offload or audit');

    // No SET LOCK_TIMEOUT this time: exercise real driver request cancellation.
    // mssql's default is 15 seconds when no requestTimeout is configured.
    const driverTimeout = pool.config.options?.requestTimeout ?? pool.config.requestTimeout ?? pool.config.timeout ?? 15000;
    assert.ok(Number.isFinite(driverTimeout) && driverTimeout >= 1000 && driverTimeout <= 30000,
      'Driver timeout must be bounded at 1-30 seconds for this rehearsal');
    console.log('DRIVER REQUEST TIMEOUT MS', driverTimeout);
    const beforeDriverTimeout = await state();
    await holdFlight();
    const timeoutRequest = call('POST', body);
    let watchdog;
    let driverFailure;
    try {
      driverFailure = await Promise.race([
        timeoutRequest,
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Driver timeout watchdog expired')), driverTimeout + 15000); })
      ]);
    } finally {
      clearTimeout(watchdog);
      await blocker.rollback();
      await timeoutRequest;
    }
    assert.equal(driverFailure.status, 500);
    assert.ok(driverFailure.errors.some(e => e.code === 'ETIMEOUT'), 'Must observe driver ETIMEOUT');
    assert.deepEqual(await state(), beforeDriverTimeout);
    pass('real driver request timeout: rollback, lock release, no offload or audit');

    const actors = await query(`SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.AuditEvents');`);
    const actorColumn = ['ActorDisplayName','UserDisplayName','ActorName'].find(n => actors.some(c => c.name === n));
    assert.ok(actorColumn);
    const beforeFailure = await state();
    const failName = 'CK_PhaseB_Rehearsal_ForceAuditFailure';
    // An additive test-only CHECK forces a real audit INSERT failure; using a
    // trigger would also interfere with OUTPUT INSERTED and obscure the cause.
    await pool.request().batch(`ALTER TABLE dbo.AuditEvents WITH CHECK ADD CONSTRAINT ${failName} CHECK (${quote(actorColumn)} <> N'Phase B forced audit failure');`);
    try {
      const failed = await call('POST', body, 'Phase B forced audit failure');
      assert.equal(failed.status, 500);
      assert.ok(failed.errors.some(e => e.number === 547));
      assert.match(failed.body.detail, new RegExp(failName));
      assert.deepEqual(await state(), beforeFailure);
    } finally { await pool.request().batch(`ALTER TABLE dbo.AuditEvents DROP CONSTRAINT ${failName};`); }
    const retry = await call('POST', body);
    assert.equal(retry.status, 201, 'A subsequent request must succeed after rollback');
    pass('forced real audit CHECK failure rolls back offload; subsequent retry succeeds');

    const legacy = await query('SELECT FlightId,UldId,OffloadStatus FROM dbo.Offloads WHERE OffloadId=9;');
    assert.equal(legacy[0].OffloadStatus, 'REQUESTED', 'Start this mode on a fresh migrated rehearsal copy');
    assert.equal((await transition('9', 'REQUESTED', 'TRANSIT')).status, 200);
    const legacyStale = await state();
    assert.equal((await transition('9', 'REQUESTED', 'TRANSIT')).body.code, 'STALE_STATUS');
    assert.deepEqual(await state(), legacyStale);
    assert.equal((await transition('9', 'TRANSIT', 'COMPLETE')).status, 200);
    const progressed = (await query('SELECT FlightId,UldId,OffloadStatus FROM dbo.Offloads WHERE OffloadId=9;'))[0];
    assert.equal(progressed.FlightId, null);
    assert.equal(progressed.UldId, null);
    assert.equal(progressed.OffloadStatus, 'COMPLETE');
    assert.equal(await snapshot('Offloads', 'OffloadId=12'), history12);
    pass('legacy 9 transitions by OffloadId with NULL identity; historical 12 stays byte-for-byte equivalent');
    console.log('REHEARSAL COMPLETE. Keep this disposable copy as evidence; do not back-copy it to production.');
  } finally {
    restoreInstrumentation();
    if (oldConnection === undefined) delete env.DATABASE_CONNECTION_STRING;
    else env.DATABASE_CONNECTION_STRING = oldConnection;
    await pool.close();
  }
}

main().catch(error => {
  // Avoid printing a connection config or connection-string credentials.
  console.error('REHEARSAL FAILED:', error.code || error.name, error.number || '', error.message);
  process.exitCode = 1;
});
