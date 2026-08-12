'use strict';

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'x-internal-token', 'x-csrf-token'];

function parseOrigins(value = '') {
  return [...new Set(String(value).split(',').map((origin) => origin.trim()).filter(Boolean))];
}

function createCorsOptions(value = '') {
  const origins = parseOrigins(value);
  const enabled = origins.length > 0;
  return {
    origin: enabled ? origins : false,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    credentials: enabled,
    optionsSuccessStatus: 204,
    maxAge: 600,
  };
}

module.exports = { ALLOWED_METHODS, createCorsOptions, parseOrigins };
