'use strict';

/**
 * Logger estruturado para R-Observe Discovery Engine.
 *
 * Niveis: error, warn, info, debug
 * Controlado por LOG_LEVEL (default: 'info')
 *
 * Em modo debug (LOG_LEVEL=debug), inclui trace_id para correlacionar
 * logs de um mesmo discovery run e fornece saida extremamente detalhada.
 *
 * Uso:
 *   LOG_LEVEL=debug npm run dev     # desenvolvimento
 *   LOG_LEVEL=debug npm start       # producao com debug
 */

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[LOG_LEVEL] ?? LEVELS.info;

/** @type {Map<string, {startedAt: number, stage: string}>} */
const traces = new Map();
let _traceCounter = 0;

function startTrace(label) {
  const id = `${label || 'discovery'}-${Date.now()}-${++_traceCounter}`;
  traces.set(id, { startedAt: Date.now(), stage: 'init' });
  _emit('debug', `trace:started id=${id}`, { trace_id: id, label });
  return id;
}

function traceStage(traceId, stage) {
  const t = traces.get(traceId);
  if (t) {
    const elapsed = Date.now() - t.startedAt;
    t.stage = stage;
    _emit('debug', `trace:stage ${stage} (+${elapsed}ms)`, { trace_id: traceId, stage, elapsed_ms: elapsed });
  }
}

function endTrace(traceId, summary) {
  const t = traces.get(traceId);
  if (t) {
    const elapsed = Date.now() - t.startedAt;
    _emit('debug', `trace:ended id=${traceId} total=${elapsed}ms`, { trace_id: traceId, elapsed_ms: elapsed, ...(summary || {}) });
    traces.delete(traceId);
  }
}

function _emit(level, msg, extra) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl > CURRENT_LEVEL) return;
  const entry = { level, service: 'r-observe-discovery', msg, ts: new Date().toISOString() };
  if (extra) Object.assign(entry, extra);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function error(msg, extra)   { _emit('error', msg, extra); }
function warn(msg, extra)    { _emit('warn', msg, extra); }
function info(msg, extra)    { _emit('info', msg, extra); }
function debug(msg, extra)   { _emit('debug', msg, extra); }
function log(level, msg, extra) { _emit(level, msg, extra); }

/**
 * Log tabular (array de objetos) — apenas em modo debug.
 */
function debugTable(label, rows, traceId) {
  if (CURRENT_LEVEL < LEVELS.debug) return;
  _emit('debug', `table:${label}`, { trace_id: traceId, count: rows.length, rows });
}

/**
 * Log de objeto arbitrario — apenas em modo debug.
 */
function debugObject(label, obj, traceId) {
  if (CURRENT_LEVEL < LEVELS.debug) return;
  _emit('debug', `obj:${label}`, { trace_id: traceId, data: obj });
}

function isDebug() {
  return CURRENT_LEVEL >= LEVELS.debug;
}

module.exports = {
  log, error, warn, info, debug,
  debugTable, debugObject, isDebug,
  startTrace, traceStage, endTrace,
  LEVELS, CURRENT_LEVEL,
};
