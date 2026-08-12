'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

const USER = process.env.ICINGAWEB_ADMIN_USER || '';
const PASS = process.env.ICINGAWEB_ADMIN_PASS || '';

test.skip(!USER || !PASS, 'Defina as credenciais administrativas para os testes autenticados.');

async function login(page) {
  await page.goto('/observe/login?next=/observe/home');
  await page.getByLabel('Usuário').fill(USER);
  await page.getByLabel('Senha').fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(url => url.pathname === '/observe/home');
  await page.waitForLoadState('networkidle');
}

test('telas principais carregam sem exceções nem recursos quebrados', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === 'http://localhost:3080' && response.status() >= 400) {
      errors.push(`HTTP ${response.status()}: ${url.pathname}`);
    }
  });
  page.on('requestfailed', request => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
      errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`);
    }
  });

  await login(page);
  for (const path of ['/observe/home', '/observe/settings', '/observe/ai', '/observe/discovery']) {
    await page.goto(path);
    await page.waitForLoadState('domcontentloaded');
    if (path === '/observe/settings') await expect(page.getByRole('tab', { name: /Descoberta/ })).toBeEnabled();
    if (path === '/observe/ai') await expect(page.locator('#metrics-grid .metric')).toHaveCount(6);
    await page.waitForTimeout(500);
  }

  expect(errors).toEqual([]);
});
