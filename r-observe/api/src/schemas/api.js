'use strict';

const identifier = { type: 'string', minLength: 1, maxLength: 128 };
const shortText = { type: 'string', maxLength: 512 };

const event = {
  type: 'object',
  required: ['type'],
  properties: {
    type: identifier,
    id: identifier,
    source: identifier,
    host: identifier,
    service: identifier,
    severity: { type: 'string', minLength: 1, maxLength: 32 },
    message: { type: 'string', maxLength: 8192 },
  },
  additionalProperties: true,
};

const icingaEvent = {
  type: 'object',
  minProperties: 1,
  additionalProperties: true,
};

const dockerInventory = {
  type: 'object',
  required: ['containers'],
  anyOf: [{ required: ['agent_id'] }, { required: ['host'] }],
  properties: {
    agent_id: identifier,
    host: identifier,
    address: { type: 'string', nullable: true, maxLength: 255 },
    containers: {
      type: 'array',
      maxItems: 5000,
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: identifier,
          id: { type: 'string', maxLength: 128 },
          image: { type: 'string', maxLength: 512 },
          state: { type: 'string', maxLength: 64 },
          health: { type: 'string', nullable: true, maxLength: 64 },
          ignored: { type: 'boolean' },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};

const remediationRequest = {
  type: 'object',
  required: ['incident_id', 'action'],
  properties: {
    incident_id: identifier,
    action: identifier,
    params: { type: 'object', maxProperties: 100, additionalProperties: true },
    reason: shortText,
  },
  additionalProperties: false,
};

const remediationApprove = {
  type: 'object',
  properties: { approved_by: identifier },
  additionalProperties: false,
};

const remediationReject = {
  type: 'object',
  properties: { rejected_by: identifier, reason: shortText },
  additionalProperties: false,
};

module.exports = {
  event,
  icingaEvent,
  dockerInventory,
  remediationRequest,
  remediationApprove,
  remediationReject,
};
