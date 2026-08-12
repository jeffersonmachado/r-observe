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
  await expect(page.locator('#metrics-grid .metric')).toHaveCount(6);
}

test.describe('Painel de IA · fluxos somente leitura', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('métricas apresentam valores numéricos', async ({ page }) => {
    const values = page.locator('#metrics-grid .metric .val');
    await expect(values).toHaveCount(6);
    const contents = await values.allTextContents();
    for (const value of contents.slice(0, 5)) expect(Number(value)).toBeGreaterThanOrEqual(0);
    expect(contents[5]).toMatch(/^\d+👍 \/ \d+👎$/);
  });

  test('abas são navegáveis pelo teclado', async ({ page }) => {
    const overview = page.getByRole('tab', { name: 'Visão Geral' });
    await overview.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Análises' })).toBeFocused();
    await expect(page.getByRole('tabpanel', { name: 'Análises' })).toBeVisible();
  });

  test('catálogo termina de carregar sem alterar ações', async ({ page }) => {
    await page.getByRole('tab', { name: 'Catálogo' }).click();
    const body = page.locator('#catalog-table tbody');
    await expect(body).not.toContainText('Carregando');
    await expect(body.locator('tr')).not.toHaveCount(0);
  });

  test('históricos de análises e remediações terminam de carregar', async ({ page }) => {
    await page.getByRole('tab', { name: 'Análises' }).click();
    await expect(page.locator('#analyses-table tbody')).not.toContainText('Carregando');
    await page.getByRole('tab', { name: 'Remediações' }).click();
    await expect(page.locator('#rem-table tbody')).not.toContainText('Carregando');
  });

  test('contatos exibem formulário rotulado sem criar usuários', async ({ page }) => {
    await page.getByRole('tab', { name: 'Contatos' }).click();
    await expect(page.getByLabel('Usuário')).toBeVisible();
    await expect(page.getByLabel('Senha inicial')).toHaveAttribute('minlength', '8');
    await expect(page.getByRole('button', { name: 'Criar' })).toBeVisible();
  });

  test('logout encerra a sessão do painel', async ({ page }) => {
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/observe\/login/);
  });
});
