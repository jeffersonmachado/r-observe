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

async function semanticIssues(page) {
  return page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden;
    };
    const name = element =>
      element.getAttribute('aria-label') || element.getAttribute('title') ||
      element.textContent?.trim() || element.querySelector('img[alt]')?.getAttribute('alt') || '';
    const issues = [];
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    for (const id of new Set(ids)) {
      if (ids.filter(candidate => candidate === id).length > 1) issues.push(`id duplicado: ${id}`);
    }
    for (const element of document.querySelectorAll('button, a[href]')) {
      if (visible(element) && !name(element)) issues.push(`${element.tagName.toLowerCase()} sem nome acessível`);
    }
    for (const input of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
      if (!visible(input)) continue;
      const labelled = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby') ||
        (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.closest('label');
      if (!labelled) issues.push(`campo sem rótulo: ${input.id || input.getAttribute('name') || input.tagName}`);
    }
    return issues;
  });
}

test('controles visíveis possuem semântica básica nas telas principais', async ({ page }) => {
  await login(page);
  for (const path of ['/observe/home', '/observe/settings', '/observe/ai', '/observe/discovery']) {
    await page.goto(path);
    if (path === '/observe/settings') {
      const tabs = page.getByRole('tab');
      await expect(tabs.first()).toBeEnabled();
      for (let index = 0; index < await tabs.count(); index += 1) {
        await tabs.nth(index).click();
        expect(await semanticIssues(page), `problemas semânticos na aba ${await tabs.nth(index).innerText()}`).toEqual([]);
      }
    }
    expect(await semanticIssues(page), `problemas semânticos em ${path}`).toEqual([]);
  }
});

test('foco de teclado permanece visível', async ({ page }) => {
  await login(page);
  for (const path of ['/observe/home', '/observe/settings', '/observe/ai']) {
    await page.goto(path);
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? getComputedStyle(element) : null;
      return { tag: element?.tagName || '', outline: style?.outlineStyle || 'none', width: style?.outlineWidth || '0px' };
    });
    expect(focus.tag, `${path} deve aceitar foco`).not.toBe('BODY');
    expect(focus.outline, `${path} deve mostrar foco`).not.toBe('none');
    expect(focus.width).not.toBe('0px');
  }
});
