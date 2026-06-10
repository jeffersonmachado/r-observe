'use strict';

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const ICINGA_USER = process.env.ICINGAWEB_ADMIN_USER || 'admin';
const ICINGA_PASS = process.env.ICINGAWEB_ADMIN_PASS || 'CHANGE_ME';

test('IcingaWeb2 — login admin e acesso ao dashboard', async ({ page }) => {
  // Acessa a página de login
  await page.goto(`${BASE_URL}/icinga/`);

  // Aguarda a página de login carregar
  await expect(page).toHaveTitle(/Icinga Web 2 Login/, { timeout: 15000 });

  // Preenche credenciais
  await page.fill('input[name="username"]', ICINGA_USER);
  await page.fill('input[name="password"]', ICINGA_PASS);

  // Submete o formulário
  await page.click('input[type="submit"]');

  // Aguarda redirecionamento pós-login
  await page.waitForURL(url => !url.toString().includes('/authentication/login'), { timeout: 15000 });

  // Verifica que chegou ao dashboard ou outra página autenticada
  const title = await page.title();
  console.log('Título após login:', title);
  console.log('URL após login:', page.url());

  expect(page.url()).not.toContain('/authentication/login');
  expect(title).not.toBe('Icinga Web 2 Login');
});
