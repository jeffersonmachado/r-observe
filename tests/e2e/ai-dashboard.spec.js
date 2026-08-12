'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

const USER = process.env.ICINGAWEB_ADMIN_USER || '';
const PASS = process.env.ICINGAWEB_ADMIN_PASS || '';

test.skip(!USER || !PASS, 'Defina as credenciais administrativas para os testes autenticados.');

async function login(page) {
  await page.goto('/observe/login?next=/observe/ai');
  await page.getByLabel('Usuário').fill(USER);
  await page.getByLabel('Senha').fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(url => url.pathname === '/observe/ai');
}

test('painel de IA é acessível por sessão e suas abas carregam', async ({ page }) => {
  await login(page);
  await expect(page).toHaveTitle('Results · R-Observe IA');
  await expect(page.locator('#token')).toHaveCount(0);
  await expect(page.locator('#metrics-grid .metric')).toHaveCount(6);
  await page.screenshot({ path: 'test-results/ai-dashboard.png', fullPage: true });

  await page.getByRole('tab', { name: 'Catálogo' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Catálogo' })).toBeVisible();
  await expect(page.locator('#catalog-table tbody')).not.toContainText('Carregando');

  await page.getByRole('tab', { name: 'Análises' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Análises' })).toBeVisible();
  await expect(page.locator('#analyses-table tbody')).not.toContainText('Carregando');
});
