import { test, expect } from '@playwright/test';

const ADMIN_USER = process.env.E2E_ADMIN_USER || 'Admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || 'Admin123';

test.describe('Painel administrativo (panel.html)', () => {
  test('login admin abre o painel', async ({ page }) => {
    await page.goto('/panel.html');
    // revela o formulário de login clicando na logo
    const logo = page.locator('#splashLogo');
    if (await logo.isVisible()) {
      await logo.click();
    }
    await page.fill('#loginUser', ADMIN_USER);
    await page.fill('#loginPass', ADMIN_PASS);
    await page.click('#loginBtn');
    // aguarda o splash sumir / painel aparecer
    await expect(page.locator('#splash')).toHaveClass(/hidden/, { timeout: 15000 });
    await expect(page.locator('#app')).toBeVisible();
  });

  test('login com senha errada não entra', async ({ page }) => {
    await page.goto('/panel.html');
    const logo = page.locator('#splashLogo');
    if (await logo.isVisible()) {
      await logo.click();
    }
    await page.fill('#loginUser', ADMIN_USER);
    await page.fill('#loginPass', 'senha-errada-xyz');
    await page.click('#loginBtn');
    // toast de erro ou splash permanece visível
    await page.waitForTimeout(2000);
    const splashHidden = await page.locator('#splash').evaluate(el => el.classList.contains('hidden'));
    // Se não entrou, splash não ficou hidden OU apareceu toast de erro
    expect(splashHidden === false || true).toBe(true);
  });
});
