'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeUldNumber } = require('../../api/shared/uld');
const { normalizeFlightNumber } = require('../../api/shared/flight');
const { insertAuditEvent } = require('../../api/shared/audit');
const completionAmendments = require('../../api/shared/completion-amendments');
const offloadEligibility = require('../../api/shared/offload-eligibility');

const root = path.resolve(__dirname, '..', '..');
const principal = Buffer.from(JSON.stringify({
  userDetails: 'Concurrency Tester', userId: 'test-user', userRoles: ['authenticated']
})).toString('base64');

function loadHandler(relativePath, sqlMock) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Buffer,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    console,
    require(name) {
      if (name === 'mssql') return sqlMock;
      if (name === '../shared/uld') return { normalizeUldNumber };
      if (name === '../shared/flight') return { normalizeFlightNumber };
      if (name === '../shared/audit') return { insertAuditEvent };
      if (name === '../shared/completion-amendments') return completionAmendments;
      if (name === '../shared/offload-eligibility') return offloadEligibility;
      throw new Error(`Unexpected require: ${name}`);
    }
  });
  vm.runInContext(source, context, { filename });
  return module.exports;
}

function sqlHarness({ uld, offload, flights, offloadUlds, completions = [], amendments = [], completionSchema = true, amendmentSchema = true, liveSchema = false, migrated = true } = {}) {
  const state = {
    uld: uld ? structuredClone(uld) : null,
    offload: offload ? structuredClone(offload) : null,
    flights: structuredClone(flights || [{ FlightId: 1, FlightNumber: 'CX178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' }]),
    completions: structuredClone(completions),
    amendments: structuredClone(amendments),
    offloadUlds: offloadUlds || [{ UldId: '7', FlightId: '1', UldNumber: 'AKE12345CX' }, { UldId: '7', FlightId: '100', UldNumber: 'PMC48921R7' }], extraOffloads: [], now: '2026-09-17T00:00:00.000Z', movements: [], audits: [], commits: 0, rollbacks: 0, failAudit: false, failAmendment: false,
    raceUldStatus: null, raceOffloadStatus: null, queries: []
  };

  const columns = {
    ExportCompletionRecords: completionSchema ? ['CompletionId', 'FlightId', 'SnapshotJson', 'RecordHash'] : [],
    ExportCompletionAmendments: amendmentSchema ? ['AmendmentId','CompletionId','FlightId','VersionNumber','PreviousHash','RecordHash','VerificationId','OperationId','Action','PreviousStatus','ResultingStatus','Reason','RelatedOffloadId','RelatedUldId','ActorProvider','ActorReference','ActorDisplayName','OccurredAtUtc','SnapshotJson'] : [],
    ULDs: [
      'UldId', 'FlightId', 'UldNumber', 'CurrentStatus', 'IdentityVerified',
      'AcceptedAtUtc', 'AcceptedByDisplayName', 'AcceptedByObjectId',
      'WarehouseDepartedAtUtc', 'WarehouseDepartedByDisplayName', 'WarehouseDepartedByObjectId'
    ],
    UldMovements: ['UldMovementId', 'UldId', 'FromStatus', 'ToStatus', 'OccurredAtUtc', 'ActorDisplayName', 'ActorObjectId', 'Source', 'Notes'],
    Offloads: [
      'OffloadId', 'FlightId', 'UldId', 'FlightNumber', 'UldNumber', 'ParkingBay', 'Status',
      'RequestInstruction', 'RequestedAtUtc', 'RequestedByDisplayName', 'RequestedByObjectId',
      'CollectedAtUtc', 'CollectedByDisplayName', 'CollectedByObjectId',
      'DeliveredAtUtc', 'DeliveredByDisplayName', 'DeliveredByObjectId', 'DeliveredLocation', 'CompletionNote'
    ],
    AuditEvents: ['AuditEventId', 'EventType', 'Action', 'EntityType', 'EntityId', 'FlightNumber', 'UldNumber', 'FromStatus', 'ToStatus', 'OccurredAtUtc', 'ActorDisplayName', 'ActorReference', 'Detail', 'DetailsJson']
  };

  if(liveSchema) columns.Offloads = columns.Offloads.map(c => c === 'Status' ? 'OffloadStatus' : c === 'ParkingBay' ? 'Bay' : c);
  if(!migrated) columns.Offloads = columns.Offloads.filter(c => c !== 'UldId');
  const statusField = liveSchema ? 'OffloadStatus' : 'Status';
  let lockTail=Promise.resolve();
  class Transaction {
    async begin() { this.active = true; this.snapshot = structuredClone({ uld: state.uld, offload: state.offload, extraOffloads: state.extraOffloads, movements: state.movements, audits: state.audits, amendments: state.amendments }); }
    async commit() { this.active = false; state.commits++; this.release?.(); }
    async rollback() {
      if (this.active) {
        state.uld = this.snapshot.uld; state.offload = this.snapshot.offload; state.extraOffloads = this.snapshot.extraOffloads; state.movements = this.snapshot.movements; state.audits = this.snapshot.audits; state.amendments = this.snapshot.amendments;
        this.active = false; state.rollbacks++; this.release?.();
      }
    }
  }

  class Request {
    constructor(transaction) { this.transaction = transaction; this.values = {}; this.parameters = {}; }
    input(name, type, value) { this.values[name] = value; this.parameters[name] = { value }; return this; }
    async query(text) {
      const q = String(text).replace(/\s+/g, ' ').trim();
      const p = this.values;
      state.queries.push({ q, p: { ...p } });
      const result = (recordset = [], rowsAffected = []) => ({ recordset, recordsets: [recordset], rowsAffected });

      if (q.includes('sys.sp_getapplock') && Object.hasOwn(p, 'OffloadFlightLockResource')) return result([{ LockResult: 0 }]);

      if (q.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
        const table = p.TableName || p.AuditTableName || Object.entries(p).find(([k]) => k.startsWith('TableName_'))?.[1];
        return result((columns[table] || []).map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES', IS_IDENTITY: COLUMN_NAME.endsWith('Id') ? 1 : 0 })));
      }
      if (q.includes("OBJECT_ID(N'dbo.ExportCompletionRecords'")) return result([{
        BaseObjectId: completionSchema ? 1 : null, AmendmentObjectId: amendmentSchema ? 2 : null
      }]);
      if (q.includes('FROM dbo.Flights WHERE FlightId=@StatementFlightId')) {
        return result(state.flights.filter(f => String(f.FlightId) === String(p.StatementFlightId)).map(f => ({ ...f, Direction: f.Direction || 'EXPORT' })));
      }
      if (q.includes('FROM dbo.ExportCompletionRecords WHERE FlightId=@StatementBaseFlightId')) {
        return result(state.completions.filter(c => String(c.FlightId) === String(p.StatementBaseFlightId)));
      }
      if (q.includes('FROM dbo.ExportCompletionAmendments') && Object.hasOwn(p, 'StatementCompletionId')) {
        return result(state.amendments.filter(a => String(a.CompletionId) === String(p.StatementCompletionId)).sort((a, b) => a.VersionNumber - b.VersionNumber));
      }
      if (q.includes('FROM dbo.ULDs u INNER JOIN dbo.Flights')) {
        if (p.AuditUldId) return result(state.uld ? [{ ...state.uld, FlightNumber: state.uld.FlightNumber || 'CX178' }] : []);
        return result(state.uld && String(state.uld.UldId) === String(p.UldId)
          ? [{ ...state.uld, Direction: state.uld.Direction || 'IMPORT', FlightNumber: state.uld.FlightNumber || 'CX178' }]
          : []);
      }
      if (q.startsWith('DECLARE @Now') && q.includes('UPDATE dbo.ULDs')) {
        assert.match(q, /WHERE UldId = @UldId AND CurrentStatus = @ExpectedStatus/);
        if (state.raceUldStatus) {
          state.uld.CurrentStatus = state.raceUldStatus;
          if (this.transaction?.snapshot?.uld) this.transaction.snapshot.uld.CurrentStatus = state.raceUldStatus;
          state.raceUldStatus = null;
        }
        const matched = state.uld && String(state.uld.UldId) === String(p.UldId) && state.uld.CurrentStatus === p.ExpectedStatus;
        if (matched) {
          state.uld.CurrentStatus = p.NextStatus;
          state.uld.IdentityVerified = 1;
          return result([{ OccurredAtUtc: '2026-09-17T00:00:00.000Z' }], [1]);
        }
        return result([{ OccurredAtUtc: '2026-09-17T00:00:00.000Z' }], [0]);
      }
      if (q.startsWith('INSERT INTO dbo.UldMovements')) { state.movements.push({ from: p.MoveFromStatus, to: p.MoveToStatus }); return result([], [1]); }
      if (q.startsWith('INSERT INTO dbo.AuditEvents')) {
        if (state.failAudit) throw new Error('forced audit failure');
        const row = { Action: p.AuditAction, ActorDisplayName: p.AuditActorDisplayName, FromStatus: p.AuditFromStatus, ToStatus: p.AuditToStatus, Detail: p.AuditDetail, DetailsJson: p.AuditDetailsJson, OccurredAtUtc: '2026-09-17T00:00:00.000Z' };
        state.audits.push(row); return result([row], [1]);
      }
      if (q.includes('SELECT CurrentStatus FROM dbo.ULDs')) return result(state.uld ? [{ CurrentStatus: state.uld.CurrentStatus }] : []);
      if (q.includes('SELECT * FROM dbo.ULDs')) return result(state.uld ? [{ ...state.uld }] : []);
      if (q.startsWith('UPDATE dbo.ULDs SET MailScannedAtUtc')) {
        if (!state.uld || String(state.uld.UldId) !== String(p.UldId) || state.uld.MailScannedAtUtc) return result([]);
        Object.assign(state.uld, { MailScannedAtUtc: '2026-09-17T01:00:00.000Z', MailScannedByDisplayName: p.DisplayName, MailScannedByReference: p.Reference });
        return result([{ ...state.uld }], [1]);
      }
      if (q.includes('FROM dbo.ULDs WHERE UldId=@UldId2')) return result(state.uld ? [{ ...state.uld }] : []);

      if (q.includes('FROM dbo.Flights') && Object.hasOwn(p, 'SelectedFlightId')) {
        if(this.transaction){
          const previous=lockTail;lockTail=new Promise(resolve=>this.transaction.release=resolve);await previous;
          this.transaction.snapshot=structuredClone({uld:state.uld,offload:state.offload,extraOffloads:state.extraOffloads,movements:state.movements,audits:state.audits,amendments:state.amendments});
        }
        const rows=state.flights.map(f=>({...f,Direction:f.Direction||'EXPORT'}));
        return result(p.SelectedFlightId ? rows.filter(f=>String(f.FlightId)===String(p.SelectedFlightId)) : rows.filter(f=>f.Direction==='EXPORT'&&['ACTIVE','CLOSED','FINALISED','FINALIZED'].includes(f.FlightStatus)));
      }
      if(q.includes('FROM dbo.Flights WITH (UPDLOCK, HOLDLOCK)') && p.AmendmentMutationFlightId) {
        if(this.transaction){
          const previous=lockTail;lockTail=new Promise(resolve=>this.transaction.release=resolve);await previous;
          this.transaction.snapshot=structuredClone({uld:state.uld,offload:state.offload,extraOffloads:state.extraOffloads,movements:state.movements,audits:state.audits,amendments:state.amendments});
        }
        return result(state.flights.filter(f=>String(f.FlightId)===String(p.AmendmentMutationFlightId)).map(f=>({FlightStatus:f.FlightStatus})));
      }
      if(q.includes('FROM dbo.Flights WITH (UPDLOCK, HOLDLOCK)') && p.AmendmentFlightId) return result(state.flights.filter(f=>String(f.FlightId)===String(p.AmendmentFlightId)).map(f=>({...f,Direction:f.Direction||'EXPORT'})));
      if(q.includes('FROM dbo.ULDs WITH (UPDLOCK, HOLDLOCK)')) {
        const flightId=p.EligibilityFlightId??p.FlightId;
        return result(state.offloadUlds.filter(u=>String(u.FlightId)===String(flightId)));
      }
      if(q.includes('FROM dbo.ULDs') && Object.hasOwn(p,'EligibilityFlightId')) return result(state.offloadUlds.filter(u=>String(u.FlightId)===String(p.EligibilityFlightId)));
      if(q.includes('FROM dbo.ExportCompletionRecords WITH (UPDLOCK, HOLDLOCK)')) return result(state.completions.filter(c=>String(c.FlightId)===String(p.AmendmentBaseFlightId)));
      if(q.includes('FROM dbo.ExportCompletionAmendments WITH (UPDLOCK, HOLDLOCK)')) {
        const rows=state.amendments.filter(a=>String(a.CompletionId)===String(p.AmendmentBaseId)).sort((a,b)=>a.VersionNumber-b.VersionNumber);
        return result(rows);
      }
      if(q.includes('FROM dbo.Offloads WITH (UPDLOCK, HOLDLOCK)') && Object.hasOwn(p,'EvidenceFlightId')) {
        return result([state.offload,...state.extraOffloads].filter(o=>o&&String(o.FlightId)===String(p.EvidenceFlightId)).sort((a,b)=>Number(a.OffloadId)-Number(b.OffloadId)).map(o=>({
          offloadId:String(o.OffloadId),flightId:String(o.FlightId),uldId:o.UldId==null?null:String(o.UldId),flightNumber:o.FlightNumber||null,
          uldNumber:o.UldNumber||null,parkingBay:o.Bay||o.ParkingBay||null,status:o[statusField]||null,requestedAtUtc:o.RequestedAtUtc||null,
          requestedByDisplayName:o.RequestedByDisplayName||null,collectedAtUtc:o.CollectedAtUtc||null,collectedByDisplayName:o.CollectedByDisplayName||null,
          deliveredAtUtc:o.DeliveredAtUtc||null,deliveredByDisplayName:o.DeliveredByDisplayName||null,deliveredLocation:o.DeliveredLocation||null,
          requestInstruction:o.RequestInstruction||null,completionNote:o.CompletionNote||null
        })));
      }
      if(q.includes('FROM dbo.Offloads WITH (UPDLOCK, HOLDLOCK)') && Object.hasOwn(p,'EligibilityFlightId')) return result([state.offload,...state.extraOffloads].filter(o=>o&&String(o.FlightId)===String(p.EligibilityFlightId)));
      if(q.includes('FROM dbo.Offloads') && Object.hasOwn(p,'EligibilityFlightId')) return result([state.offload,...state.extraOffloads].filter(o=>o&&String(o.FlightId)===String(p.EligibilityFlightId)));
      if(q.includes('FROM dbo.Offloads WITH (UPDLOCK, HOLDLOCK)')) return result([state.offload,...state.extraOffloads].filter(o=>o&&String(o.FlightId)===String(p.FlightId)&&['REQUESTED','TRANSIT'].includes(o[statusField])));
      if(q.startsWith('DECLARE @OccurredAtUtc')) return result([{OccurredAtUtc:new Date(state.now),OccurredAtIso:state.now}]);
      if(q.startsWith('INSERT INTO dbo.ExportCompletionAmendments')) {
        if(state.failAmendment) throw new Error('forced amendment failure');
        const row={AmendmentId:String(state.amendments.length+1),CompletionId:String(p.CompletionBaseId),FlightId:String(p.CompletionFlightId),
          VersionNumber:p.CompletionVersion,PreviousHash:p.CompletionPreviousHash,RecordHash:p.CompletionRecordHash,VerificationId:p.CompletionVerificationId,
          OperationId:p.CompletionOperationId,Action:p.CompletionAction,PreviousStatus:p.CompletionPreviousStatus,ResultingStatus:p.CompletionResultingStatus,
          Reason:p.CompletionReason,RelatedOffloadId:String(p.CompletionOffloadId),
          RelatedUldId:String(p.CompletionUldId),ActorProvider:p.CompletionActorProvider,ActorReference:p.CompletionActorReference,
          ActorDisplayName:p.CompletionActorDisplayName,OccurredAtIso:state.now,SnapshotJson:p.CompletionSnapshotJson};
        state.amendments.push(row);return result([{AmendmentId:row.AmendmentId}],[1]);
      }
      if (q.startsWith('SELECT * FROM dbo.Offloads WHERE')) {
        const id = p.OffloadId ?? p.LatestOffloadId;
        return result(state.offload && String(state.offload.OffloadId) === String(id) ? [{ ...state.offload }] : []);
      }
      if (p.ConflictFlightId) return result([state.offload,...state.extraOffloads].filter(o=>o&&String(o.FlightId)===String(p.ConflictFlightId)&&(p.ConflictUldId===undefined||String(o.UldId)===String(p.ConflictUldId))));
      if (q.includes('FROM dbo.Flights WITH (UPDLOCK, HOLDLOCK)')) return result(state.flights.filter(f => String(f.FlightId) === String(p.SelectedFlightId)));
      if (q.startsWith('SELECT o.*') && q.includes('@SummaryFlightId')) {
        return result([state.offload,...state.extraOffloads]
          .filter(o=>o&&String(o.FlightId)===String(p.SummaryFlightId))
          .sort((a,b)=>String(a.RequestedAtUtc||'').localeCompare(String(b.RequestedAtUtc||''))||Number(a.OffloadId)-Number(b.OffloadId))
          .map(o=>{const flight=state.flights.find(f=>String(f.FlightId)===String(o.FlightId));return {...o,__OffloadIdText:String(o.OffloadId),__FlightIdText:String(o.FlightId),__UldIdText:o.UldId==null?null:String(o.UldId),__FlightOperatingDate:flight?.OperatingDate||null}}));
      }
      if (q.startsWith('SELECT o.*') && q.includes('LEFT JOIN dbo.Flights')) {
        if (!state.offload) return result([]);
        const flight = state.flights.find(f => String(f.FlightId) === String(state.offload.FlightId));
        return result([{ ...state.offload, __FlightOperatingDate: flight?.OperatingDate || null }]);
      }
      if (q.startsWith('INSERT INTO dbo.Offloads')) {
        if(state.uniqueViolation) {
          const competitor={OffloadId:'91',FlightId:p.FlightId,UldId:p.UldId,UldNumber:p.UldNumber,[statusField]:'REQUESTED'};
          state.extraOffloads.push(competitor);
          if(this.transaction?.snapshot) this.transaction.snapshot.extraOffloads.push(structuredClone(competitor));
          const error=new Error('UX_Offloads_ActiveFlightUld duplicate');error.number=2601;throw error;
        }
        if(state.offload) state.extraOffloads.push(structuredClone(state.offload));
        state.offload = { OffloadId: 90+state.extraOffloads.length, FlightId: p.FlightId, UldId: p.UldId, FlightNumber: p.FlightNumber, UldNumber: p.UldNumber, [liveSchema ? 'Bay' : 'ParkingBay']: p.ParkingBay, [statusField]: p.Status, RequestInstruction:p.RequestInstruction, RequestedAtUtc:state.now };
        return result([{ ...state.offload }], [1]);
      }
      if (q.startsWith('UPDATE dbo.Offloads')) {
        assert.ok(q.includes('WHERE [OffloadId] = @OffloadId AND ['+statusField+'] = @ExpectedStatus'));
        if (state.raceOffloadStatus) {
          state.offload[statusField] = state.raceOffloadStatus;
          if (this.transaction?.snapshot?.offload) this.transaction.snapshot.offload[statusField] = state.raceOffloadStatus;
          state.raceOffloadStatus = null;
        }
        const matched = state.offload && String(state.offload.OffloadId) === String(p.OffloadId) && state.offload[statusField] === p.ExpectedStatus;
        if (!matched) return result([], [0]);
        state.offload[statusField] = p.NextStatus;
        if (p.NextStatus === 'COMPLETE') state.offload.DeliveredLocation = p.DeliveredLocation;
        return result([{ ...state.offload }], [1]);
      }
      if (q.includes('AS CurrentStatus FROM dbo.Offloads')) return result(state.offload ? [{ CurrentStatus: state.offload[statusField] }] : []);
      throw new Error(`Unhandled SQL: ${q}`);
    }
  }

  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }

  const sql = {
    ConnectionPool, Transaction, Request,
    NVarChar: n => `nvarchar(${n})`, VarChar: n => `varchar(${n})`,
    BigInt: 'bigint', Int: 'int', DateTime2: n => `datetime2(${n})`, MAX: 'max'
  };
  return { sql, state };
}

async function call(handler, method, body, query) {
  const context = { log: { error() {}, warn() {} } };
  await handler(context, { method, body, query, headers: { 'x-ms-client-principal': principal } });
  return { status: context.res.status, body: JSON.parse(context.res.body) };
}


module.exports={sqlHarness,loadHandler,call};
