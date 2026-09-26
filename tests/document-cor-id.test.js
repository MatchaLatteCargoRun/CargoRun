'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DOCUMENT_COR_ID_MAX_LENGTH,
  DOCUMENT_COR_ID_VALIDATION_CODE,
  DOCUMENT_COR_ID_VALIDATION_MESSAGE,
  DocumentCorIdValidationError,
  canonicalizeDocumentCorId
} = require('../api/shared/document-cor-id');

const root = path.resolve(__dirname, '..');

test('DocumentCorID canonical form preserves repository identifiers and uses ASCII case normalization', () => {
  assert.equal(DOCUMENT_COR_ID_MAX_LENGTH, 100);
  assert.equal(canonicalizeDocumentCorId('DOC-1'), 'DOC-1');
  assert.equal(canonicalizeDocumentCorId('  global-document-same-station  '), 'GLOBAL-DOCUMENT-SAME-STATION');
  assert.equal(canonicalizeDocumentCorId('a'.repeat(100)), 'A'.repeat(100));
});

test('DocumentCorID validation fails closed without Unicode folding or truncation', () => {
  const invalid = [
    null,
    undefined,
    123,
    '',
    '   ',
    'DOC ID',
    'DOC\tID',
    'DOC\rID',
    'DOC\nID',
    'DOC\0ID',
    'DOC\u00a0ID',
    '\u00a0DOC-ID',
    'DOC-ID\u2003',
    'DOC-\uff21',
    'stra\u00dfe',
    '\u0131d',
    'A'.repeat(101)
  ];

  for (const value of invalid) {
    assert.throws(
      () => canonicalizeDocumentCorId(value),
      error => {
        assert.ok(error instanceof DocumentCorIdValidationError, String(value));
        assert.equal(error.code, DOCUMENT_COR_ID_VALIDATION_CODE, String(value));
        assert.equal(error.status, 422, String(value));
        assert.equal(error.message, DOCUMENT_COR_ID_VALIDATION_MESSAGE, String(value));
        return true;
      }
    );
  }
});

test('the sole IncomingMachMessages identity writer uses the shared canonical helper and global lock', () => {
  const endpointSources = fs.readdirSync(path.join(root, 'api'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      file: `api/${entry.name}/index.js`,
      absolute: path.join(root, 'api', entry.name, 'index.js')
    }))
    .filter(entry => fs.existsSync(entry.absolute))
    .map(entry => ({ ...entry, source: fs.readFileSync(entry.absolute, 'utf8') }));

  const identityWriters = endpointSources
    .filter(entry => /INSERT\s+INTO\s+dbo\.IncomingMachMessages/i.test(entry.source))
    .map(entry => entry.file);
  assert.deepEqual(identityWriters, ['api/mach-fow/index.js']);

  const mach = endpointSources.find(entry => entry.file === 'api/mach-fow/index.js').source;
  const validation = mach.indexOf('documentCorId = canonicalizeDocumentCorId(');
  const lock = mach.indexOf('await acquireDocumentIdentityLock(tx, documentCorId)');
  const insert = mach.search(/INSERT\s+INTO\s+dbo\.IncomingMachMessages/i);
  assert.ok(validation >= 0 && validation < lock && lock < insert);
  assert.match(mach, /function documentIdentityLockResource[\s\S]*canonicalizeDocumentCorId\(documentCorId\)/);
  assert.match(mach, /m\.DocumentCorID COLLATE Latin1_General_100_BIN2[\s\S]*@DocumentCorID COLLATE Latin1_General_100_BIN2/);
  assert.doesNotMatch(mach, /UPDATE\s+dbo\.IncomingMachMessages[\s\S]{0,300}\bDocumentCorID\s*=/i);
  assert.doesNotMatch(mach, /DELETE\s+FROM\s+dbo\.IncomingMachMessages/i);
});
