'use strict';

const DOCUMENT_COR_ID_MAX_LENGTH = 100;
const DOCUMENT_COR_ID_VALIDATION_CODE = 'INVALID_DOCUMENT_COR_ID';
const DOCUMENT_COR_ID_VALIDATION_MESSAGE =
  'DocumentCorID must be a string containing 1-100 ASCII letters, digits, or hyphens';

class DocumentCorIdValidationError extends Error {
  constructor() {
    super(DOCUMENT_COR_ID_VALIDATION_MESSAGE);
    this.name = 'DocumentCorIdValidationError';
    this.code = DOCUMENT_COR_ID_VALIDATION_CODE;
    this.status = 422;
  }
}

// DocumentCorID is an external identifier, not free text. Only U+0020 is
// treated as edge whitespace. Other whitespace, control characters and all
// non-ASCII input fail closed instead of being folded into another identity.
function canonicalizeDocumentCorId(value) {
  if (typeof value !== 'string') throw new DocumentCorIdValidationError();

  const trimmed = value.replace(/^ +| +$/g, '');
  if (
    trimmed.length < 1 ||
    trimmed.length > DOCUMENT_COR_ID_MAX_LENGTH ||
    !/^[A-Za-z0-9-]+$/.test(trimmed)
  ) {
    throw new DocumentCorIdValidationError();
  }

  return trimmed.replace(/[a-z]/g, character =>
    String.fromCharCode(character.charCodeAt(0) - 32)
  );
}

module.exports = {
  DOCUMENT_COR_ID_MAX_LENGTH,
  DOCUMENT_COR_ID_VALIDATION_CODE,
  DOCUMENT_COR_ID_VALIDATION_MESSAGE,
  DocumentCorIdValidationError,
  canonicalizeDocumentCorId
};
