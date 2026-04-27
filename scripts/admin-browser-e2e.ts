import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { assert, getEnv, logStep, logSuccess, ScriptError } from './lib/runtime';
import { readSmokeConfig } from './lib/smoke-config';

async function waitForText(
  locator: { innerText(): Promise<string> },
  matcher: RegExp,
  timeoutMs = 15_000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = await locator.innerText().catch(() => '');
    if (matcher.test(text)) {
      return text;
    }

    await delay(250);
  }

  throw new ScriptError(`Timed out waiting for text ${matcher}.`);
}

async function main() {
  const smokeConfig = readSmokeConfig();
  const adminUiUrl = getEnv('SHEETFLARE_ADMIN_UI_URL') || 'http://127.0.0.1:4173';

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

    logStep(`Open admin UI at ${adminUiUrl}`);
    await page.goto(adminUiUrl, { waitUntil: 'domcontentloaded' });

    logStep('Authenticate in the admin UI');
    await page.getByLabel('Admin credential').fill(smokeConfig.adminCredential);
    await page.getByRole('button', { name: 'Save and load' }).click();
    await page.getByRole('heading', { name: 'Projects' }).waitFor({ state: 'visible' });
    await page.getByTestId(`project-card-${smokeConfig.privateProject}`).waitFor({ state: 'visible' });
    logSuccess('Admin UI loaded project cards');

    logStep('Select the private project with keyboard activation');
    const projectCard = page.getByTestId(`project-card-${smokeConfig.privateProject}`);
    await projectCard.focus();
    await page.keyboard.press('Enter');
    const projectPressed = await projectCard.getAttribute('aria-pressed');
    assert(projectPressed === 'true', 'Project card should react to keyboard activation.');
    logSuccess('Project card is keyboard-activatable');

    logStep('Load cache for the private table');
    const projectTableCard = page.getByTestId(`table-card-${smokeConfig.privateTable}`);
    await projectTableCard.waitFor({ state: 'visible' });
    await projectTableCard.getByRole('button', { name: 'Load cache' }).click();
    const cacheText = await waitForText(
      projectTableCard.locator('dd').nth(2),
      /ready \/ fresh \/ \d+ rows/
    );
    assert(cacheText.includes('ready / fresh /'), 'Cache state did not update after load.');
    logSuccess('Cache state rendered in the admin UI');

    logStep('Trigger a reindex from the admin UI');
    await projectTableCard.getByRole('button', { name: 'Reindex' }).click();
    await page.getByText(/Reindexing .* complete\./).waitFor({ state: 'visible' });
    logSuccess('Reindex action completed from the admin UI');

    console.log('\n[done] admin browser checks passed');
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[failed] ${message}`);
  process.exit(1);
});
