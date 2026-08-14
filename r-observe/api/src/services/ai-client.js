'use strict';

/**
 * Cliente de chat genérico para o serviço r-observe-ai.
 * Usado pelo bot do WhatsApp (intenção + inferência/RAG).
 */

function createAIChatClient({
  aiServiceUrl,
  signToken,
  fetchImpl = global.fetch,
  timeoutMs = 20000,
  log = () => {},
}) {
  async function chat(messages) {
    const jwt = signToken({
      sub: 'r-observe-api',
      service: 'api',
      role: 'operator',
      aud: 'ai',
      scope: ['ai:access'],
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(`${aiServiceUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': jwt },
        body: JSON.stringify({ messages }),
        signal: ctrl.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) return null;
      return { content: data.content || '' };
    } catch (e) {
      log('warn', 'AI chat unavailable', { err: e.message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { chat };
}

module.exports = { createAIChatClient };
