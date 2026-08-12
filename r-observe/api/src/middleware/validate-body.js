'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});

function publicErrors(errors = []) {
  return errors.map(({ instancePath, keyword, message, params }) => ({
    path: instancePath || '/',
    keyword,
    message,
    ...(keyword === 'required' ? { missing: params.missingProperty } : {}),
  }));
}

function validateBody(schema) {
  const validate = ajv.compile(schema);
  return function bodySchemaMiddleware(req, res, next) {
    if (validate(req.body)) return next();
    return res.status(400).json({
      error: 'invalid_request',
      details: publicErrors(validate.errors),
    });
  };
}

module.exports = { validateBody, publicErrors };
