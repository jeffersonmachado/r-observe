'use strict';

/**
 * Servidor MCP (Model Context Protocol) minimal para o R-Observe.
 *
 * Expõe ferramentas read-only sobre o estado operacional (status, incidentes e
 * ativos) via JSON-RPC 2.0 sobre stdio. Não requer rede nem secrets extras:
 * lê as mesmas variáveis DB_* usadas pela API.
 *
 * Uso:
 *   DB_HOST=... DB_PORT=5432 DB_NAME=... DB_USER=... DB_PASSWORD=... \
 *     node r-observe/mcp/server.js
 *
 * Integração (clientes MCP como VS Code/Claude): registre o comando acima como
 * um servidor MCP stdio. As ferramentas disponíveis são:
 *   - r_observe_status
 *   - r_observe_incidents
 *   - r_observe_assets
 */

const readline = require('readline');
const { createDbClient } = require('../api/src/db');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'r-observe-mcp';
const SERVER_VERSION = '0.1.0';

const db = createDbClient(process.env);

const TOOLS = [
  {
    name: 'r_observe_status',
    description: 'Resumo operacional do R-Observe: agentes discovery, ativos monitorados e incidentes abertos.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'r_observe_incidents',
    description: 'Lista os incidentes abertos (não resolvidos) do R-Observe.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Máximo de incidentes (padrão 10, máx 50)' } },
    },
  },
  {
    name: 'r_observe_assets',
    description: 'Lista os ativos monitorados pelo R-Observe.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Máximo de ativos (padrão 20, máx 100)' } },
    },
  },
];

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

async function callTool(name, args = {}) {
  if (name === 'r_observe_status') {
    const agents = await db.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='online')::int AS online
       FROM observe_discovery_agents`
    );
    const assets = await db.query(`SELECT COUNT(*)::int AS total FROM observe_assets`);
    const inc = await db.query(
      `SELECT COUNT(*)::int AS open FROM observe_incidents WHERE status NOT IN ('resolved','closed')`
    );
    return {
      agents: agents.rows[0] || { total: 0, online: 0 },
      assets_total: assets.rows[0]?.total ?? 0,
      open_incidents: inc.rows[0]?.open ?? 0,
    };
  }

  if (name === 'r_observe_incidents') {
    const limit = clampLimit(args.limit, 10, 50);
    const r = await db.query(
      `SELECT title, severity, status, created_at
       FROM observe_incidents
       WHERE status NOT IN ('resolved','closed')
       ORDER BY created_at DESC LIMIT ${limit}`
    );
    return { incidents: r.rows };
  }

  if (name === 'r_observe_assets') {
    const limit = clampLimit(args.limit, 20, 100);
    const r = await db.query(
      `SELECT asset_name, primary_ip, vendor
       FROM observe_assets
       WHERE primary_ip IS NOT NULL
       ORDER BY updated_at DESC LIMIT ${limit}`
    );
    return { assets: r.rows };
  }

  throw new Error(`Ferramenta desconhecida: ${name}`);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleRequest(req) {
  if (!req || typeof req !== 'object') return;

  if (req.method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }

  if (req.method === 'notifications/initialized') return; // notificação, sem resposta

  if (req.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
  }

  if (req.method === 'tools/call') {
    const { name, arguments: args } = req.params || {};
    try {
      const data = await callTool(name, args || {});
      return send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
      });
    } catch (e) {
      return send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true },
      });
    }
  }

  if (req.id !== undefined) {
    return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Método não suportado: ${req.method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try { req = JSON.parse(text); } catch { return; }
  handleRequest(req).catch((e) => {
    if (req && req.id !== undefined) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e.message } });
    }
  });
});

rl.on('close', () => { db.end().catch(() => {}); });
