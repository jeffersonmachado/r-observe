'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ALLOWED_METHODS, createCorsOptions, parseOrigins } = require('../src/http/cors-options');

describe('CORS policy', () => {
  it('keeps cross-origin access disabled without an explicit allowlist', () => {
    const options = createCorsOptions('  ');
    assert.equal(options.origin, false);
    assert.equal(options.credentials, false);
  });

  it('normalizes and deduplicates configured origins', () => {
    assert.deepEqual(
      parseOrigins(' https://app.example.test,https://ops.example.test, https://app.example.test '),
      ['https://app.example.test', 'https://ops.example.test'],
    );
  });

  it('enables credentialed requests only for the explicit allowlist', () => {
    const options = createCorsOptions('https://app.example.test');
    assert.deepEqual(options.origin, ['https://app.example.test']);
    assert.equal(options.credentials, true);
    assert.equal(options.optionsSuccessStatus, 204);
  });

  it('advertises every HTTP method exposed by the API', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.equal(ALLOWED_METHODS.includes(method), true, `${method} ausente da política CORS`);
    }
  });
});
