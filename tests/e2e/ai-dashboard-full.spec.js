'use strict';
const { test, expect } = require('@playwright/test');

const BASE  = process.env.BASE_URL || 'http://localhost:3080';
const TOKEN = process.env.OBSERVE_TOKEN || '';

test.skip(!TOKEN, 'Defina OBSERVE_TOKEN para rodar testes autenticados.');

test.describe('AI Dashboard — /observe/ai', () => {

  test.beforeEach(async ({ page }) => {
    // Injeta token via sessionStorage antes de carregar a página
    await page.goto(`${BASE}/observe/ai`);
    await page.evaluate(t => sessionStorage.setItem('observe_token', t), TOKEN);
    await page.reload();
    await page.waitForTimeout(2500); // aguarda loadAll()
  });

  test('página carrega sem erros de console', async ({ page }) => {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.waitForTimeout(1000);
    const console401 = errors.filter(e => e.includes('401'));
    expect(console401).toHaveLength(0);
    await expect(page).toHaveTitle('R-Observe · IA Dashboard');
  });

  test('métricas carregam com valores numéricos', async ({ page }) => {
    const metrics = page.locator('#metrics-grid .metric');
    await expect(metrics).toHaveCount(6, { timeout: 8000 });
    // Primeiro card: "Analisados" — deve ter número
    const firstVal = await metrics.first().locator('.val').textContent();
    expect(Number(firstVal)).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: 'test-results/ai-overview.png', fullPage: true });
  });

  test('aba Análises lista incidentes com análise IA', async ({ page }) => {
    await page.click('.tab:has-text("Análises")');
    await page.waitForTimeout(500);
    const rows = page.locator('#analyses-table tbody tr');
    const count = await rows.count();
    // Deve ter pelo menos 1 linha (sem ser o placeholder "Carregando")
    expect(count).toBeGreaterThan(0);
    const first = await rows.first().textContent();
    expect(first).not.toContain('Carregando');
    await page.screenshot({ path: 'test-results/ai-analyses-full.png', fullPage: true });
  });

  test('aba Catálogo exibe as 8 ações', async ({ page }) => {
    await page.click('.tab:has-text("Catálogo")');
    await page.waitForTimeout(500);
    const rows = page.locator('#catalog-table tbody tr');
    await expect(rows).toHaveCount(8, { timeout: 6000 });

    // Verifica ações esperadas
    const text = await page.locator('#catalog-table').textContent();
    expect(text).toContain('icinga:reschedule');
    expect(text).toContain('icinga:silence');
    expect(text).toContain('icinga:add-comment');
    expect(text).toContain('docker:stop');
    expect(text).toContain('http:verify');
    await page.screenshot({ path: 'test-results/ai-catalog-full.png', fullPage: true });
  });

  test('desativar e reativar ação do catálogo', async ({ page }) => {
    await page.click('.tab:has-text("Catálogo")');
    await page.waitForTimeout(500);

    // Clica Desativar no docker:stop
    const stopRow = page.locator('#catalog-table tbody tr', { hasText: 'docker:stop' });
    await stopRow.locator('button:has-text("Desativar")').click();

    // Toast de confirmação
    const toast = page.locator('#toast');
    await expect(toast).toBeVisible({ timeout: 4000 });
    await expect(toast).toHaveClass(/ok/);
    await expect(toast).toContainText('docker:stop');

    // Aguarda refresh e botão muda para "Ativar"
    await page.waitForTimeout(2000);
    await expect(stopRow.locator('button:has-text("Ativar")')).toBeVisible({ timeout: 6000 });

    // Reativa
    await stopRow.locator('button:has-text("Ativar")').click();
    await page.waitForTimeout(2000);
    await expect(stopRow.locator('button:has-text("Desativar")')).toBeVisible({ timeout: 6000 });
  });

  test('feedback 👍 em análise recente', async ({ page }) => {
    await page.click('.tab:has-text("Análises")');
    await page.waitForTimeout(500);

    const firstThumbUp = page.locator('#analyses-table button:has-text("👍")').first();
    await expect(firstThumbUp).toBeVisible({ timeout: 6000 });
    await firstThumbUp.click();

    const toast = page.locator('#toast');
    await expect(toast).toBeVisible({ timeout: 4000 });
    await expect(toast).toHaveClass(/ok/);
    await expect(toast).toContainText('positivo');
  });

  test('aba Remediações lista histórico', async ({ page }) => {
    await page.click('.tab:has-text("Remediações")');
    await page.waitForTimeout(500);
    const rows = page.locator('#rem-table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    const first = await rows.first().textContent();
    expect(first).not.toContain('Carregando');
    await page.screenshot({ path: 'test-results/ai-remediations.png', fullPage: true });
  });

  test('sem token: mostra mensagem orientativa sem 401', async ({ page }) => {
    // Limpa token
    await page.evaluate(() => sessionStorage.removeItem('observe_token'));
    await page.reload();
    await page.waitForTimeout(1500);

    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.waitForTimeout(500);

    // Sem 401 no console
    expect(errors.filter(e => e.includes('401'))).toHaveLength(0);

    // Mostra mensagem orientativa
    const grid = await page.locator('#metrics-grid').textContent();
    expect(grid).toContain('JWT_SECRET');
    await page.screenshot({ path: 'test-results/ai-no-token.png', fullPage: true });
  });
});
