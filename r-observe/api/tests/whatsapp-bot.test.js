'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWhatsAppBot, pickCommand } = require('../src/services/whatsapp-bot');

const db = {
  async query(sql) {
    if (sql.includes('observe_discovery_agents')) {
      return { rowCount: 1, rows: [{ total: 3, online: 1 }] };
    }
    if (sql.includes('FROM observe_assets') && sql.includes('COUNT')) {
      return { rowCount: 1, rows: [{ total: 42 }] };
    }
    if (sql.includes('FROM observe_assets')) {
      return { rowCount: 2, rows: [
        { asset_name: 'host-a', primary_ip: '10.0.0.1' },
        { asset_name: 'host-b', primary_ip: '10.0.0.2' },
      ] };
    }
    if (sql.includes('observe_incidents') && sql.includes('COUNT')) {
      return { rowCount: 1, rows: [{ open: 2 }] };
    }
    if (sql.includes('observe_incidents')) {
      return { rowCount: 1, rows: [{ title: 'Host down', severity: 'critical', status: 'open', created_at: new Date() }] };
    }
    return { rowCount: 0, rows: [] };
  },
};

describe('WhatsApp bot', () => {
  it('classifica comandos', () => {
    assert.equal(pickCommand('status'), 'status');
    assert.equal(pickCommand('  RESUMO '), 'status');
    assert.equal(pickCommand('/alertas'), 'incidents');
    assert.equal(pickCommand('ativos'), 'assets');
    assert.equal(pickCommand('oi'), 'help');
    assert.equal(pickCommand('qualquer coisa'), 'help');
  });

  it('status responde com resumo do sistema', async () => {
    const bot = createWhatsAppBot({ db, log: () => {} });
    const reply = await bot.handleMessage({ text: 'status' });
    assert.match(reply, /Agentes Discovery: 1\/3 online/);
    assert.match(reply, /Ativos monitorados: 42/);
    assert.match(reply, /Incidentes abertos: 2/);
  });

  it('incidentes lista incidentes abertos', async () => {
    const bot = createWhatsAppBot({ db, log: () => {} });
    const reply = await bot.handleMessage({ text: 'alertas' });
    assert.match(reply, /Host down/);
    assert.match(reply, /critical/);
  });

  it('fallback de erro retorna mensagem amigável', async () => {
    const failingDb = { async query() { throw new Error('db down'); } };
    const bot = createWhatsAppBot({ db: failingDb, log: () => {} });
    const reply = await bot.handleMessage({ text: 'status' });
    assert.match(reply, /Não consegui consultar/);
  });

  it('IA infere a intenção e roteia para o comando determinístico', async () => {
    const aiChat = async (messages) => {
      const last = messages[messages.length - 1].content;
      if (last.includes('Classifique a intenção')) return { content: '{"intent":"assets"}' };
      return { content: 'resposta da IA' };
    };
    const bot = createWhatsAppBot({ db, log: () => {}, aiChat });
    const reply = await bot.handleMessage({ text: 'quantos ativos eu tenho?' });
    assert.match(reply, /Ativos monitorados: 42/);
  });

  it('pergunta livre é respondida com contexto (RAG)', async () => {
    const aiChat = async (messages) => {
      const last = messages[messages.length - 1].content;
      if (last.includes('Classifique a intenção')) return { content: '{"intent":"question"}' };
      return { content: 'Há 2 incidentes abertos, incluindo Host down (critical).' };
    };
    const ragContext = { async build() { return '# Contexto\n- Incidentes abertos: 2'; } };
    const bot = createWhatsAppBot({ db, log: () => {}, aiChat, ragContext });
    const reply = await bot.handleMessage({ text: 'o que está acontecendo?' });
    assert.match(reply, /Há 2 incidentes abertos/);
  });
});
