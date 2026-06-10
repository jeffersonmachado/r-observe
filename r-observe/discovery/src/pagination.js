'use strict';

/**
 * Paginação cursor-based para R-Observe Discovery (Enterprise).
 *
 * Substitui os LIMIT fixos (500) por cursores baseados em coluna de ordenação.
 * Suporta ordenação ASC/DESC e navegação forward/backward.
 *
 * Uso:
 *   const pag = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
 *   const { sql, params } = applyPagination(baseQuery, baseParams, pag, 'updated_at');
 *   const rows = await db.query(sql, params);
 *   const result = paginatedResponse(rows, pag);
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Parse query params de paginação.
 * Aceita: ?limit=50&after=2024-01-01T00:00:00Z&before=2024-06-01T00:00:00Z&sort=asc
 */
function parsePagination(query = {}, opts = {}) {
  const limit = Math.min(
    Math.max(1, parseInt(query.limit || opts.defaultLimit || DEFAULT_LIMIT, 10)),
    opts.maxLimit || MAX_LIMIT
  );
  const sort = (query.sort || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const after = query.after || null;
  const before = query.before || null;

  return { limit, sort, after, before };
}

/**
 * Aplica WHERE de cursor + ORDER BY + LIMIT a uma query SQL base.
 *
 * @param {string} baseQuery - Query base (SELECT ... FROM ... WHERE ...)
 *                              Deve ter os placeholders $1, $2, $3, $4 para os
 *                              parametros base (tenant, site, edge, etc.)
 * @param {Array} baseParams - Parametros da query base
 * @param {object} pag - Resultado de parsePagination()
 * @param {string} cursorColumn - Coluna usada como cursor (ex: 'updated_at', 'created_at', 'started_at')
 * @param {string} [tableAlias] - Alias da tabela para a coluna cursor (ex: 'a', 't')
 * @returns {{ sql: string, params: Array }}
 */
function applyPagination(baseQuery, baseParams, pag, cursorColumn, tableAlias) {
  const col = tableAlias ? `${tableAlias}.${cursorColumn}` : cursorColumn;
  const params = [...baseParams];
  let whereClause = '';
  let paramIdx = params.length + 1;

  if (pag.after) {
    const op = pag.sort === 'ASC' ? '>' : '<';
    whereClause = ` AND ${col} ${op} $${paramIdx}`;
    params.push(pag.after);
    paramIdx++;
  }

  if (pag.before) {
    const op = pag.sort === 'ASC' ? '<' : '>';
    whereClause += ` AND ${col} ${op} $${paramIdx}`;
    params.push(pag.before);
    paramIdx++;
  }

  const sql = `${baseQuery}${whereClause} ORDER BY ${col} ${pag.sort} LIMIT $${paramIdx}`;
  params.push(pag.limit + 1); // +1 para detectar has_more

  return { sql, params };
}

/**
 * Aplica paginação a uma query que já tem WHERE completo (sem placeholders fixos).
 *
 * @param {string} fullQuery - Query completa com WHERE
 * @param {Array} params - Parametros já existentes
 * @param {object} pag - Resultado de parsePagination()
 * @param {string} cursorColumn - Coluna cursor
 * @param {string} [tableAlias] - Alias da tabela
 */
function applyPaginationToQuery(fullQuery, params, pag, cursorColumn, tableAlias) {
  const col = tableAlias ? `${tableAlias}.${cursorColumn}` : cursorColumn;
  const newParams = [...params];
  let whereClause = '';
  let paramIdx = newParams.length + 1;

  if (pag.after) {
    const op = pag.sort === 'ASC' ? '>' : '<';
    whereClause = ` AND ${col} ${op} $${paramIdx}`;
    newParams.push(pag.after);
    paramIdx++;
  }

  if (pag.before) {
    const op = pag.sort === 'ASC' ? '<' : '>';
    whereClause += ` AND ${col} ${op} $${paramIdx}`;
    newParams.push(pag.before);
    paramIdx++;
  }

  const sql = `${fullQuery}${whereClause} ORDER BY ${col} ${pag.sort} LIMIT $${paramIdx}`;
  newParams.push(pag.limit + 1);

  return { sql, params: newParams };
}

/**
 * Formata resposta paginada.
 * Detecta se há mais resultados (has_more) e fornece cursores para próxima/anterior.
 *
 * @param {Array} rows - Linhas retornadas pela query
 * @param {object} pag - Config de paginação usada
 * @param {string} cursorColumn - Coluna cursor
 * @param {function} [formatRow] - Função opcional para formatar cada linha
 * @returns {{ data: Array, pagination: object }}
 */
function paginatedResponse(rows, pag, cursorColumn, formatRow) {
  const hasMore = rows.length > pag.limit;
  const data = hasMore ? rows.slice(0, pag.limit) : rows;

  const result = {
    data: formatRow ? data.map(formatRow) : data,
    pagination: {
      limit: pag.limit,
      sort: pag.sort === 'ASC' ? 'asc' : 'desc',
      returned: data.length,
      has_more: hasMore,
    },
  };

  if (data.length > 0) {
    const firstCursor = data[0][cursorColumn];
    const lastCursor = data[data.length - 1][cursorColumn];

    if (pag.after || pag.before || data.length === pag.limit + 1) {
      result.pagination.cursors = {
        first: firstCursor instanceof Date ? firstCursor.toISOString() : String(firstCursor),
        last: lastCursor instanceof Date ? lastCursor.toISOString() : String(lastCursor),
      };
    }

    if (!pag.before && rows.length <= pag.limit && !pag.after) {
      // Primeira página, sem cursores de navegação necessários
    } else if (hasMore) {
      result.pagination.next_cursor = lastCursor instanceof Date
        ? lastCursor.toISOString()
        : String(lastCursor);
    }
  }

  return result;
}

module.exports = {
  parsePagination,
  applyPagination,
  applyPaginationToQuery,
  paginatedResponse,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
