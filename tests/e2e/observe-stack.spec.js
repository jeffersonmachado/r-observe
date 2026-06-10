'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TOKEN    = process.env.OBSERVE_TOKEN || '';
const API      = `${BASE_URL}/observe/api`;

test.skip(!TOKEN, 'Defina OBSERVE_TOKEN para rodar testes autenticados.');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiGet(request, path) {
  return request.get(`${API}${path}`, {
    headers: { 'x-internal-token': TOKEN },
  });
}

async function apiPost(request, path, body) {
  return request.post(`${API}${path}`, {
    headers: { 'x-internal-token': TOKEN, 'Content-Type': 'application/json' },
    data: body,
  });
}

async function fillToken(page) {
  await page.fill('#token', TOKEN);
  await page.dispatchEvent('#token', 'input');
}

// ─── 1. API — Health & Status ─────────────────────────────────────────────────

test.describe('API · Health e Status', () => {
  test('GET /health retorna ok', async ({ request }) => {
    const r = await apiGet(request, '/health');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('r-observe-api');
  });

  test('GET /status retorna DB e Redis ok', async ({ request }) => {
    const r = await apiGet(request, '/status');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.components.db).toBe('ok');
    expect(body.components.redis).toBe('ok');
  });

  test('GET sem token retorna 401', async ({ request }) => {
    const r = await request.get(`${API}/hosts`);
    expect(r.status()).toBe(401);
  });
});

// ─── 2. API — Hosts ───────────────────────────────────────────────────────────

test.describe('API · Hosts CRUD', () => {
  const testHost = { name: 'pw-test-host', address: '10.99.0.1', display_name: 'Playwright Test Host' };

  test.afterAll(async ({ request }) => {
    await apiPost(request, '/hosts', {}).catch(() => {});
    await request.delete(`${API}/hosts/${testHost.name}`, {
      headers: { 'x-internal-token': TOKEN },
    }).catch(() => {});
  });

  test('POST /hosts cria host e salva no banco', async ({ request }) => {
    const r = await apiPost(request, '/hosts', testHost);
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.host.name).toBe(testHost.name);
    expect(body.host.address).toBe(testHost.address);
    expect(body.host.id).toBeTruthy();
    // Icinga pode estar fora — apenas valida que o campo existe
    expect(body.icinga).toBeDefined();
  });

  test('GET /hosts lista inclui host criado', async ({ request }) => {
    const r = await apiGet(request, '/hosts');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.total).toBeGreaterThan(0);
    const found = body.hosts.find(h => h.name === testHost.name);
    expect(found).toBeDefined();
    expect(found.address).toBe(testHost.address);
  });

  test('GET /hosts/:name retorna host individual', async ({ request }) => {
    const r = await apiGet(request, `/hosts/${testHost.name}`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.host.name).toBe(testHost.name);
  });

  test('GET /hosts/inexistente retorna 404', async ({ request }) => {
    const r = await apiGet(request, '/hosts/nao-existe-xyz');
    expect(r.status()).toBe(404);
  });

  test('POST /hosts com nome inválido retorna 400', async ({ request }) => {
    const r = await apiPost(request, '/hosts', { name: 'nome com espaço!', address: '1.2.3.4' });
    expect(r.status()).toBe(400);
  });

  test('POST /hosts sem address retorna 400', async ({ request }) => {
    const r = await apiPost(request, '/hosts', { name: 'host-sem-addr' });
    expect(r.status()).toBe(400);
  });

  test('DELETE /hosts/:name remove do banco', async ({ request }) => {
    const r = await request.delete(`${API}/hosts/${testHost.name}`, {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.removed).toBe(true);

    const check = await apiGet(request, `/hosts/${testHost.name}`);
    expect(check.status()).toBe(404);
  });
});

// ─── 3. API — Eventos e Incidentes ───────────────────────────────────────────

test.describe('API · Eventos e Incidentes', () => {
  test('POST /events aceita evento genérico', async ({ request }) => {
    const r = await apiPost(request, '/events', {
      type: 'check.failed',
      host: 'pw-router',
      address: '10.99.1.1',
      severity: 'warning',
      source: 'playwright',
    });
    expect(r.status()).toBe(202);
    const body = await r.json();
    expect(body.accepted).toBe(true);
    expect(body.id).toBeTruthy();
  });

  test('POST /events sem type retorna 400', async ({ request }) => {
    const r = await apiPost(request, '/events', { host: 'x' });
    expect(r.status()).toBe(400);
  });

  test('GET /incidents retorna lista', async ({ request }) => {
    // Aguarda worker processar (até 3s)
    await new Promise(r => setTimeout(r, 3000));
    const resp = await apiGet(request, '/incidents');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body.incidents)).toBe(true);
    expect(body.total).toBeGreaterThan(0);
  });

  test('GET /incidents/:id retorna incidente com timeline', async ({ request }) => {
    const list = await (await apiGet(request, '/incidents')).json();
    const id = list.incidents[0]?.id;
    expect(id).toBeTruthy();

    const r = await apiGet(request, `/incidents/${id}`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.incident.id).toBe(id);
    expect(Array.isArray(body.timeline)).toBe(true);
  });
});

// ─── 4. API — AI ──────────────────────────────────────────────────────────────

test.describe('API · AI', () => {
  test('GET /ai/settings retorna provider e has_api_key', async ({ request }) => {
    const r = await apiGet(request, '/ai/settings');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(['openai', 'anthropic', 'deepseek', 'mock']).toContain(body.provider);
    expect(typeof body.has_api_key).toBe('boolean');
  });

  test('GET /ai/models?provider=openai retorna lista ordenada', async ({ request }) => {
    const r = await apiGet(request, '/ai/models?provider=openai');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.models.length).toBeGreaterThan(10);
    expect(['api', 'static']).toContain(body.source);
    // Primeiro modelo deve ser da família mais recente (gpt-5 ou o4)
    expect(body.models[0]).toMatch(/^(gpt-5|o4)/);
  });

  test('GET /ai/models?provider=anthropic retorna modelos Claude', async ({ request }) => {
    const r = await apiGet(request, '/ai/models?provider=anthropic');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.models.every(m => m.startsWith('claude-'))).toBe(true);
  });

  test('POST /ai/explain com mock retorna análise', async ({ request }) => {
    const r = await apiPost(request, '/ai/explain', {
      incident: { id: 'pw-inc-01', title: 'HOST.DOWN test-host', severity: 'critical', source: 'playwright' },
      context:  { event_output: 'Connection refused', event_service: 'HTTP' },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.summary).toBeTruthy();
    expect(body.provider).toBeTruthy();
  });
});

// ─── 5. API — Scan trigger ────────────────────────────────────────────────────

test.describe('API · Hosts Scan', () => {
  test('POST /hosts/scan enfileira tarefa', async ({ request }) => {
    const r = await apiPost(request, '/hosts/scan', { subnet: '10.10.2.0/24' });
    expect(r.status()).toBe(202);
    const body = await r.json();
    expect(body.accepted).toBe(true);
    expect(body.subnet).toBe('10.10.2.0/24');
    expect(body.message).toMatch(/observe:discover/);
  });

  test('POST /hosts/scan sem subnet usa auto-detect', async ({ request }) => {
    const r = await apiPost(request, '/hosts/scan', {});
    expect(r.status()).toBe(202);
    const body = await r.json();
    expect(body.subnet).toBe('auto-detect');
  });
});

// ─── 6. UI — Página de configuração IA ───────────────────────────────────────

test.describe('UI · /observe/settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/observe/settings`);
  });

  test('página carrega com título correto', async ({ page }) => {
    await expect(page).toHaveTitle('R-Observe · Configuração IA');
  });

  test('status passa de "Consultando" para estado definido', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#status-dot')).not.toHaveClass(/dot warn.*Consultando/, { timeout: 8000 });
    await expect(page.locator('#status-value')).not.toBeEmpty({ timeout: 8000 });
  });

  test('botão Salvar habilita após carregar com token', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });
  });

  test('dropdown MODELO tem opção Automático ao selecionar OpenAI', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });
    // Provider mock oculta o select — garante provider com modelos
    await page.click('button[data-provider="openai"]');
    await expect(page.locator('#model-section')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('#model')).toContainText('Automático', { timeout: 8000 });
  });

  test('seleção de provider Anthropic carrega modelos Claude', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });

    await page.click('button[data-provider="anthropic"]');
    await expect(page.locator('#model')).toContainText('claude-', { timeout: 6000 });
  });

  test('seleção de provider Mock esconde seção API KEY', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });

    await page.click('button[data-provider="mock"]');
    await expect(page.locator('#api-key-section')).not.toBeVisible();
  });

  test('token inválido mantém Salvar desabilitado', async ({ page }) => {
    await page.fill('#token', 'invalid-token-xyz');
    await page.dispatchEvent('#token', 'input');
    await page.click('button:has-text("↺")');
    await expect(page.locator('#status-dot')).toHaveClass(/dot err/, { timeout: 6000 });
    await expect(page.locator('#save-btn')).toBeDisabled();
  });
});
