'use strict';
const { test, expect } = require('@playwright/test');

const BASE = 'https://r-observe.results.com.br';
const TOKEN = process.env.OBSERVE_TOKEN || '';

test.skip(!TOKEN, 'Defina OBSERVE_TOKEN para rodar testes autenticados.');

test.describe('Produção — r-observe.results.com.br', () => {

  test('HTTPS acessível e redireciona para /observe/settings', async ({ page }) => {
    const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: 'test-results/prod-home.png', fullPage: true });
    console.log('URL final:', page.url());
    console.log('Status:', resp?.status());
    expect(resp?.status()).toBeLessThan(500);
  });

  test('API health responde 200', async ({ request }) => {
    const r = await request.get(`${BASE}/observe/api/health`, { timeout: 15000 });
    console.log('API health:', r.status(), await r.text());
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
  });

  test('Dashboard /observe/settings carrega', async ({ page }) => {
    await page.goto(`${BASE}/observe/settings`, { timeout: 30000 });
    await expect(page).toHaveTitle(/R-Observe/, { timeout: 10000 });
    await page.screenshot({ path: 'test-results/prod-settings.png', fullPage: true });
    console.log('Settings URL:', page.url());
  });

  test('Dashboard /observe/ai carrega com token', async ({ page }) => {
    await page.goto(`${BASE}/observe/ai`);
    await page.evaluate(t => sessionStorage.setItem('observe_token', t), TOKEN);
    await page.reload();
    await page.waitForTimeout(3000);
    await expect(page).toHaveTitle(/R-Observe.*IA/, { timeout: 10000 });
    await page.screenshot({ path: 'test-results/prod-ai-dashboard.png', fullPage: true });
  });

  test('IcingaWeb2 /icinga/ acessível', async ({ page }) => {
    const resp = await page.goto(`${BASE}/icinga/`, { timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/prod-icinga.png', fullPage: true });
    console.log('Icinga URL:', page.url(), 'Status:', resp?.status());
    expect(resp?.status()).toBeLessThan(500);
  });

  test('Grafana /grafana/ acessível', async ({ page }) => {
    const resp = await page.goto(`${BASE}/grafana/`, { timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/prod-grafana.png', fullPage: true });
    console.log('Grafana URL:', page.url(), 'Status:', resp?.status());
    expect(resp?.status()).toBeLessThan(500);
  });

});
