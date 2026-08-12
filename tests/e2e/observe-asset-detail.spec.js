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
}

test.describe('R-Observe · detalhes de ativo', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('metadados expandem por teclado e comunicam o estado', async ({ page }) => {
    const assetId = await page.evaluate(async () => {
      const response = await fetch('/observe/api/discovery/assets?limit=1');
      if (!response.ok) throw new Error(`Inventário indisponível: ${response.status}`);
      const body = await response.json();
      return body.assets?.[0]?.id || null;
    });
    test.skip(!assetId, 'Nenhum ativo disponível para validar os detalhes.');

    await page.goto(`/observe/assets/${assetId}`);
    const scan = page.getByRole('button', { name: /Scan/ });
    await expect(scan).toBeVisible();
    await expect(scan).toHaveAttribute('aria-expanded', 'false');
    await scan.focus();
    await page.keyboard.press('Enter');
    await expect(scan).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#mc-scan')).toBeVisible();
  });

  test('logout encerra a sessão a partir dos detalhes', async ({ page }) => {
    const assetId = await page.evaluate(async () => {
      const body = await (await fetch('/observe/api/discovery/assets?limit=1')).json();
      return body.assets?.[0]?.id || null;
    });
    test.skip(!assetId, 'Nenhum ativo disponível para validar os detalhes.');

    await page.goto(`/observe/assets/${assetId}`);
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/observe\/login/);
    await page.goto(`/observe/assets/${assetId}`);
    await expect(page).toHaveURL(/\/observe\/login\?next=/);
  });
});
