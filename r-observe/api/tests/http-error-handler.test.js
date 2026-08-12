'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { classifyHttpError, createHttpErrorHandler } = require('../../shared/http-error-handler');

function invoke(err) {
  const logs = [];
  let status;
  let body;
  const handler = createHttpErrorHandler({
    service: 'test-service',
    log(level, message, fields) { logs.push({ level, message, fields }); },
  });
  handler(
    err,
    { method: 'POST', path: '/events' },
    {
      headersSent: false,
      status(value) { status = value; return this; },
      json(value) { body = value; return this; },
    },
    () => assert.fail('next não deveria ser chamado'),
  );
  return { status, body, logs };
}

describe('Shared HTTP error handler', () => {
  it('classifies malformed JSON as a safe 400 response', () => {
    const err = new SyntaxError('Unexpected token near super-secret-value');
    err.status = 400;
    err.type = 'entity.parse.failed';
    const result = invoke(err);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'invalid_json' });
    assert.doesNotMatch(JSON.stringify(result.logs), /super-secret-value/);
  });

  it('returns 413 for bodies rejected by the size limit', () => {
    assert.deepEqual(
      classifyHttpError({ type: 'entity.too.large', status: 413 }),
      { status: 413, error: 'payload_too_large', level: 'warn' },
    );
  });

  it('does not expose internal exception messages', () => {
    const result = invoke(new Error('database password leaked here'));
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'internal_error' });
    assert.doesNotMatch(JSON.stringify(result), /database password leaked here/);
  });

  it('preserves safe client status codes with a generic error', () => {
    assert.deepEqual(
      classifyHttpError({ statusCode: 422 }),
      { status: 422, error: 'invalid_request', level: 'warn' },
    );
  });
});
