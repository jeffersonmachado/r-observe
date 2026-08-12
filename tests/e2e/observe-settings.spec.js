'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

const USER = process.env.ICINGAWEB_ADMIN_USER || '';
const PASS = process.env.ICINGAWEB_ADMIN_PASS || '';

test.skip(!USER || !PASS, 'Defina ICINGAWEB_ADMIN_USER e ICINGAWEB_ADMIN_PASS para os testes autenticados.');

async function login(page) {
  await page.goto('/observe/login?next=/observe/settings');
  await page.getByLabel('Usuário').fill(USER);
  await page.getByLabel('Senha').fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(url => url.pathname === '/observe/settings' && !url.searchParams.has('next'));
}

async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((element, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test.describe('R-Observe · configuração por sessão', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('carrega a configuração sem expor campo de token interno', async ({ page }) => {
    await expect(page).toHaveTitle('R-Observe · Configuração');
    await expect(page.locator('#token')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Descoberta/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText('Configuração de Descoberta');
  });

  test('navega entre seções por teclado', async ({ page }) => {
    const discovery = page.getByRole('tab', { name: /Descoberta/ });
    await expect(discovery).toBeEnabled();
    await discovery.focus();
    await page.keyboard.press('ArrowRight');

    const ai = page.getByRole('tab', { name: /IA/ });
    await expect(ai).toBeFocused();
    await expect(ai).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText('Provider de IA');
  });

  test('indica alterações pendentes e habilita salvar seção', async ({ page }) => {
    const save = page.locator('#save-section-btn');
    await expect(save).toBeDisabled();
    await setRange(page, '#sld-scan_interval', 65);

    await expect(save).toBeEnabled();
    await expect(page.locator('#dirty-status')).toContainText('não salvas');
  });

  test('pede confirmação antes de descartar mudanças ao trocar de seção', async ({ page }) => {
    await setRange(page, '#sld-scan_interval', 65);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('tab', { name: /Agentes/ }).click();

    await expect(page.getByRole('tab', { name: /Descoberta/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('logout encerra a sessão e retorna ao login', async ({ page }) => {
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/observe\/login/);
    await page.goto('/observe/settings');
    await expect(page).toHaveURL(/\/observe\/login\?next=/);
  });
});
