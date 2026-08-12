'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('R-Observe · primeiro acesso', () => {
  test('página protegida redireciona para o login e preserva o destino', async ({ page }) => {
    await page.goto('/observe/settings');

    await expect(page).toHaveURL(/\/observe\/login\?next=%2Fobserve%2Fsettings$/);
    await expect(page).toHaveTitle('R-Observe · Login');
    await expect(page.getByLabel('Usuário')).toBeVisible();
    await expect(page.getByLabel('Senha')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  });

  test('login exige usuário e senha antes de enviar', async ({ page }) => {
    await page.goto('/observe/login');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page.getByLabel('Usuário')).toBeFocused();
    await expect(page.getByLabel('Usuário')).toHaveAttribute('required', '');
    await expect(page.getByLabel('Senha')).toHaveAttribute('required', '');
  });

  test('login permanece utilizável em viewport móvel', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/observe/login');

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });
});
