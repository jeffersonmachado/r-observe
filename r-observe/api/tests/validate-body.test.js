'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { validateBody } = require('../src/middleware/validate-body');
const schemas = require('../src/schemas/api');

function execute(schema, body) {
  let statusCode;
  let response;
  let nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { response = value; return this; },
  };
  validateBody(schema)({ body }, res, () => { nextCalled = true; });
  return { statusCode, response, nextCalled };
}

describe('JSON Schema request validation', () => {
  it('accepts an extensible event contract', () => {
    const result = execute(schemas.event, {
      type: 'container.stopped', host: 'node-01', custom_evidence: { exit_code: 1 },
    });
    assert.equal(result.nextCalled, true);
  });

  it('rejects events without type without reflecting submitted values', () => {
    const result = execute(schemas.event, { message: 'sensitive-value' });
    assert.equal(result.statusCode, 400);
    assert.equal(result.response.error, 'invalid_request');
    assert.equal(result.response.details[0].missing, 'type');
    assert.doesNotMatch(JSON.stringify(result.response), /sensitive-value/);
  });

  it('limits Docker inventory size and requires container names', () => {
    const unnamed = execute(schemas.dockerInventory, { agent_id: 'agent-01', containers: [{}] });
    assert.equal(unnamed.statusCode, 400);
    assert.equal(unnamed.response.details.some((error) => error.missing === 'name'), true);

    const excessive = execute(schemas.dockerInventory, {
      host: 'node-01', containers: Array.from({ length: 5001 }, () => ({ name: 'container' })),
    });
    assert.equal(excessive.statusCode, 400);
  });

  it('rejects unknown remediation fields while accepting an empty approval', () => {
    const invalid = execute(schemas.remediationRequest, {
      incident_id: 'incident-01', action: 'service:restart', unexpected: true,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.response.details.some((error) => error.keyword === 'additionalProperties'), true);

    assert.equal(execute(schemas.remediationApprove, {}).nextCalled, true);
  });

  it('requires JSON objects instead of null or arrays', () => {
    assert.equal(execute(schemas.event, null).statusCode, 400);
    assert.equal(execute(schemas.icingaEvent, []).statusCode, 400);
  });
});
