'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TOKEN    = process.env.OBSERVE_TOKEN || '';
const API      = `${BASE_URL}/observe/api`;

test.skip(!TOKEN, 'Defina OBSERVE_TOKEN para rodar testes autenticados.');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fillToken(page) {
  await page.fill('#token', TOKEN);
  // Dispara 'input' para atualizar _authToken e sessionStorage
  await page.dispatchEvent('#token', 'input');
}

async function waitForStatus(page, dotClass, timeout = 8000) {
  await expect(page.locator('#status-dot'))
    .toHaveClass(new RegExp(`dot ${dotClass}`), { timeout });
}

// ─── Testes ───────────────────────────────────────────────────────────────────

test.describe('R-Observe · Página de configuração IA', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/observe/settings`);
  });

  // ── Carregamento ──────────────────────────────────────────────────────────

  test('página carrega com título correto', async ({ page }) => {
    await expect(page).toHaveTitle('R-Observe · Configuração IA');
  });

  test('botão Salvar começa desabilitado', async ({ page }) => {
    await expect(page.locator('#save-btn')).toBeDisabled();
  });

  test('status inicia como "Consultando" antes de ter token', async ({ page }) => {
    await expect(page.locator('#status-text')).toHaveText(/Consultando|Token inválido|Cole o JWT_SECRET/);
  });

  // ── Autenticação ──────────────────────────────────────────────────────────

  test('status fica vermelho com token errado', async ({ page }) => {
    await page.fill('#token', 'token-invalido-xpto');
    await page.dispatchEvent('#token', 'input');
    await page.click('button:has-text("↺")');
    await waitForStatus(page, 'err');
    await expect(page.locator('#save-btn')).toBeDisabled();
  });

  test('status carrega e botão Salvar é habilitado com token correto', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    // Aguarda qualquer estado conectado (ok = verde, warn = amarelo/mock)
    await expect(page.locator('#status-dot')).not.toHaveClass(/dot err/, { timeout: 8000 });
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });
  });

  test('token é persistido no sessionStorage', async ({ page }) => {
    await fillToken(page);
    const stored = await page.evaluate(() => sessionStorage.getItem('observe_token'));
    expect(stored).toBe(TOKEN);
  });

  test('token sobrevive ao refresh e loadStatus funciona sem redigitar', async ({ page }) => {
    // 1ª visita: salva o token
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });

    // Simula F5 — sessionStorage persiste, _authToken deve ser restaurado
    await page.reload();

    // Não digita nada — loadStatus() deve usar o token do sessionStorage via _authToken
    await expect(page.locator('#status-dot')).not.toHaveClass(/dot err/, { timeout: 8000 });
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });
  });

  // ── Seleção de provider ───────────────────────────────────────────────────

  test('botão OpenAI ativa classe active e exibe campo de modelo', async ({ page }) => {
    await fillToken(page);
    await page.click('button[data-provider="openai"]');
    await expect(page.locator('button[data-provider="openai"]')).toHaveClass(/active/);
    await expect(page.locator('#model-section')).toBeVisible();
    await expect(page.locator('#api-key-section')).toBeVisible();
  });

  test('botão Anthropic ativa classe active e exibe campo de modelo', async ({ page }) => {
    await fillToken(page);
    await page.click('button[data-provider="anthropic"]');
    await expect(page.locator('button[data-provider="anthropic"]')).toHaveClass(/active/);
    await expect(page.locator('#model-section')).toBeVisible();
  });

  test('botão Mock oculta modelo e chave', async ({ page }) => {
    await fillToken(page);
    // Primeiro ativa outro provider para garantir que os campos aparecem
    await page.click('button[data-provider="openai"]');
    await expect(page.locator('#model-section')).toBeVisible();
    // Agora volta para mock
    await page.click('button[data-provider="mock"]');
    await expect(page.locator('#model-section')).toBeHidden();
    await expect(page.locator('#api-key-section')).toBeHidden();
  });

  test('apenas um provider fica ativo por vez', async ({ page }) => {
    await fillToken(page);
    await page.click('button[data-provider="openai"]');
    await page.click('button[data-provider="anthropic"]');
    const activeButtons = page.locator('.provider-btn.active');
    await expect(activeButtons).toHaveCount(1);
    await expect(activeButtons).toHaveText(/Anthropic/);
  });

  // ── Combo de modelos ──────────────────────────────────────────────────────

  test('select de modelo popula ao clicar em OpenAI', async ({ page }) => {
    await fillToken(page);
    await page.click('button[data-provider="openai"]');
    // Aguarda o combo carregar (sai de "Carregando…")
    await expect(page.locator('#model option:first-child'))
      .not.toHaveText('Carregando modelos…', { timeout: 15000 });
    const options = page.locator('#model option');
    await expect(options).not.toHaveCount(0);
    // Primeiro item é sempre "Automático"
    await expect(options.first()).toHaveText(/Automático/);
  });

  test('select de modelo popula ao clicar em Anthropic', async ({ page }) => {
    await fillToken(page);
    await page.click('button[data-provider="anthropic"]');
    await expect(page.locator('#model option:first-child'))
      .not.toHaveText('Carregando modelos…', { timeout: 15000 });
    const options = page.locator('#model option');
    await expect(options).not.toHaveCount(0);
    await expect(options.first()).toHaveText(/Automático/);
  });

  test('select exibe gpt-4o-mini entre opções da OpenAI', async ({ page }) => {
    await fillToken(page);
    await page.click('button[data-provider="openai"]');
    await expect(page.locator('#model option:first-child'))
      .not.toHaveText('Carregando modelos…', { timeout: 15000 });
    await expect(page.locator('#model option[value="gpt-4o-mini"]')).toBeAttached({ timeout: 15000 });
  });

  test('hint de modelo efetivo exibe após seleção', async ({ page }) => {
    await fillToken(page);
    await page.click('button[data-provider="openai"]');
    await expect(page.locator('#model option:first-child'))
      .not.toHaveText('Carregando modelos…', { timeout: 15000 });
    await expect(page.locator('#effective-model')).toContainText(/Modelo efetivo/);
  });

  // ── Salvar configuração ───────────────────────────────────────────────────

  test('salva provider mock com sucesso', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });

    await page.click('button[data-provider="mock"]');
    await page.click('#save-btn');

    await expect(page.locator('#feedback')).toHaveClass(/ok/, { timeout: 8000 });
    await expect(page.locator('#feedback')).toContainText(/mock/i);
  });

  test('salva provider openai com modelo específico', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });

    await page.click('button[data-provider="openai"]');
    await expect(page.locator('#model option:first-child'))
      .not.toHaveText('Carregando modelos…', { timeout: 15000 });
    await page.selectOption('#model', 'gpt-4o-mini');
    await page.click('#save-btn');

    await expect(page.locator('#feedback')).toHaveClass(/ok/, { timeout: 8000 });
    await expect(page.locator('#feedback')).toContainText(/openai/i);
  });

  test('botão Salvar fica desabilitado durante o envio', async ({ page }) => {
    await fillToken(page);
    await page.click('button:has-text("↺")');
    await expect(page.locator('#save-btn')).toBeEnabled({ timeout: 8000 });

    // Intercepta a requisição para segurar o botão visível como desabilitado
    await page.route(`${API}/ai/settings`, async route => {
      await page.waitForTimeout(300);
      await route.continue();
    });

    await page.click('button[data-provider="mock"]');
    const saveBtn = page.locator('#save-btn');
    await saveBtn.click();
    await expect(saveBtn).toBeDisabled();
    // Após completar, volta habilitado
    await expect(saveBtn).toBeEnabled({ timeout: 8000 });
  });

  // ── API direta ────────────────────────────────────────────────────────────

  test('GET /observe/api/ai/settings retorna 200 com token correto', async ({ request }) => {
    const resp = await request.get(`${API}/ai/settings`, {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('provider');
    expect(body).toHaveProperty('has_api_key');
    expect(body).toHaveProperty('effective_model');
  });

  test('GET /observe/api/ai/settings retorna 401 sem token', async ({ request }) => {
    const resp = await request.get(`${API}/ai/settings`);
    expect(resp.status()).toBe(401);
  });

  test('GET /observe/api/ai/models retorna lista de modelos', async ({ request }) => {
    for (const provider of ['openai', 'anthropic', 'deepseek']) {
      const resp = await request.get(`${API}/ai/models?provider=${provider}`, {
        headers: { 'x-internal-token': TOKEN },
      });
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.models.length).toBeGreaterThan(0);
      expect(body).toHaveProperty('auto');
    }
  });

  test('POST /observe/api/ai/settings com provider inválido retorna 400', async ({ request }) => {
    const resp = await request.post(`${API}/ai/settings`, {
      headers: { 'x-internal-token': TOKEN, 'Content-Type': 'application/json' },
      data: { provider: 'nao-existe' },
    });
    expect(resp.status()).toBe(400);
  });

  test('POST /observe/api/ai/settings troca provider em runtime', async ({ request }) => {
    const resp = await request.post(`${API}/ai/settings`, {
      headers: { 'x-internal-token': TOKEN, 'Content-Type': 'application/json' },
      data: { provider: 'mock', model: 'auto' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('mock');
  });

});
