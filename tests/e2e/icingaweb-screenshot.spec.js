'use strict';

const { test, expect } = require('@playwright/test');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const ICINGA_USER = process.env.ICINGAWEB_ADMIN_USER || 'admin';
const ICINGA_PASS = process.env.ICINGAWEB_ADMIN_PASS || 'CHANGE_ME';

async function assertIcingaPage(page, label) {
  const title = await page.title();
  const body = await page.locator('body').innerText({ timeout: 15000 });

  console.log(`${label}:`, page.url(), title);

  expect(page.url(), `${label} nao deve voltar para login`).not.toContain('/authentication/login');
  expect(title, `${label} nao deve exibir login`).not.toBe('Icinga Web 2 Login');
  expect(body, `${label} nao deve renderizar erro HTTP/Icinga`).not.toMatch(
    /(Internal Server Error|SQLSTATE|Exception|An error occurred|Page not found|not found|permission denied)/i
  );
}

test('IcingaWeb2 — captura dashboard, hosts e serviços', async ({ page }) => {
  const documentResponses = [];
  page.on('response', response => {
    if (response.request().resourceType() === 'document') {
      documentResponses.push({ url: response.url(), status: response.status() });
    }
  });

  // Login
  await page.goto(`${BASE_URL}/icinga/`);
  await page.waitForSelector('input[name="username"]', { timeout: 15000 });
  await page.fill('input[name="username"]', ICINGA_USER);
  await page.fill('input[name="password"]', ICINGA_PASS);
  await page.click('input[type="submit"]');
  await page.waitForURL(url => !url.toString().includes('/authentication/login'), { timeout: 15000 });

  // Dashboard
  await page.screenshot({ path: 'test-results/icinga-dashboard.png', fullPage: true });
  await assertIcingaPage(page, 'Dashboard');

  // Hosts
  await page.goto(`${BASE_URL}/icinga/icingadb/hosts`);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: 'test-results/icinga-hosts.png', fullPage: true });
  await assertIcingaPage(page, 'Hosts');

  // Serviços
  await page.goto(`${BASE_URL}/icinga/icingadb/services`);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: 'test-results/icinga-services.png', fullPage: true });
  await assertIcingaPage(page, 'Services');

  // Incidentes/problemas
  await page.goto(`${BASE_URL}/icinga/icingadb/hosts?host.state.is_problem=y`);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: 'test-results/icinga-problems.png', fullPage: true });
  await assertIcingaPage(page, 'Problems');

  for (const response of documentResponses.filter(item => item.url.includes('/icinga/'))) {
    expect(response.status, `${response.url} retornou ${response.status}`).toBeLessThan(500);
  }
});
