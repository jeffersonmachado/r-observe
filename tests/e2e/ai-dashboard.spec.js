'use strict';
const { test } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TOKEN = process.env.OBSERVE_TOKEN || '';

test.skip(!TOKEN, 'Defina OBSERVE_TOKEN para rodar testes autenticados.');

test('AI Dashboard screenshot', async ({ page }) => {
  await page.goto(`${BASE_URL}/observe/ai`);
  await page.fill('#token', TOKEN);
  await page.click('button:has-text("↺")');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/ai-dashboard.png', fullPage: true });

  await page.click('.tab:has-text("Catálogo")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/ai-catalog.png', fullPage: true });

  await page.click('.tab:has-text("Análises")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/ai-analyses.png', fullPage: true });
});
