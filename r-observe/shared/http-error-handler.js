'use strict';

function classifyHttpError(err = {}) {
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return { status: 400, error: 'invalid_json', level: 'warn' };
  }
  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    return { status: 413, error: 'payload_too_large', level: 'warn' };
  }
  const status = Number(err.status || err.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, error: 'invalid_request', level: 'warn' };
  }
  return { status: 500, error: 'internal_error', level: 'error' };
}

function createHttpErrorHandler({ log, service }) {
  if (typeof log !== 'function') throw new TypeError('log deve ser função');
  return function httpErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const result = classifyHttpError(err);
    log(result.level, 'HTTP request failed', {
      service,
      status: result.status,
      error_type: result.error,
      method: req.method,
      path: req.path,
      exception: err?.name || 'Error',
    });
    return res.status(result.status).json({ error: result.error });
  };
}

module.exports = { classifyHttpError, createHttpErrorHandler };
