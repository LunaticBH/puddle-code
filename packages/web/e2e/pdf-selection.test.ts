import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

test.use({
  viewport: { width: 1000, height: 800 },
  deviceScaleFactor: 2,
  permissions: ['clipboard-read', 'clipboard-write'],
});

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => server?.close());

const firstLine = 'Select and copy this text.';
const secondLine = 'Another line stays readable.';

/** Real text, line breaks, rotation and non-default PDF units exercise PDF.js itself. */
function documentPdf(first = firstLine): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R 10 0 R 12 0 R] /Count 5 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, rotation] of [0, 0, 90, 180, 270].entries()) {
    const stream =
      `BT /F1 18 Tf 40 630 Td (${index === 0 ? first : 'Second page text.'}) Tj ` +
      `0 -30 Td (${secondLine}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Rotate ${rotation} ` +
        `/UserUnit ${index === 4 ? 2 : 1} /Resources << /Font << /F1 3 0 R >> >> ` +
        `/Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function copySelection(page: Page): Promise<string> {
  await page.evaluate(() => navigator.clipboard.writeText('Clipboard before copying'));
  await page.keyboard.press('ControlOrMeta+c');
  return page.evaluate(() => navigator.clipboard.readText());
}

async function dragLines(page: Page, first: Locator, last: Locator) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const start = await first.boundingBox();
  const end = await last.boundingBox();
  if (!start || !end) throw new Error('Missing PDF text geometry');
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe('');
}

for (const ordinary of [true, false]) {
  test(`${ordinary ? 'ordinary' : 'LaTeX'} PDF text supports native drag and copy at different zooms`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const reveals: Record<string, unknown>[] = [];
    await page.route('**/api/worktrees/session/media?*', (route) =>
      route.fulfill({ contentType: 'application/pdf', body: documentPdf() }),
    );
    await page.route('**/api/latex/synctex', (route) => {
      reveals.push(route.request().postDataJSON());
      return route.fulfill({
        json: { session: 'session', root: '/project', path: 'document.tex', line: 1 },
      });
    });
    await page.goto(`${origin}/e2e/fixtures/view-state.html${ordinary ? '?ordinary' : ''}`);
    const firstPage = page.locator('[data-pdf-page="1"]');
    const first = firstPage.getByText(firstLine, { exact: true });
    const last = firstPage.getByText(secondLine, { exact: true });
    await expect(first).toBeVisible();

    for (const zoom of ['100%', '125%', '50%']) {
      if (zoom === '125%') await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      if (zoom === '50%') {
        for (let index = 0; index < 3; index++)
          await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
      }
      await expect(
        page.getByRole('button', { name: `Zoom ${zoom}; reset to fit width` }),
      ).toBeVisible();
      await dragLines(page, first, last);
      await expect.poll(() => copySelection(page)).toBe(`${firstLine}\n${secondLine}`);
      expect(reveals).toEqual([]);
    }

    // The overlay must use the whole page's coordinates for inverse SyncTeX.
    const bounds = await firstPage.boundingBox();
    const textBounds = await first.boundingBox();
    if (!bounds || !textBounds) throw new Error('Missing PDF geometry');
    const clickX = Math.floor(textBounds.x + textBounds.width / 2);
    const clickY = Math.floor(textBounds.y + textBounds.height / 2);
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(clickX, clickY);
    await page.keyboard.up('ControlOrMeta');
    if (ordinary) {
      expect(reveals).toEqual([]);
    } else {
      await expect.poll(() => reveals.length).toBe(1);
      expect(reveals[0]).toMatchObject({ page: 1, session: 'session', path: 'document.pdf' });
      expect(reveals[0]!.x).toBeCloseTo(((clickX - bounds.x) / bounds.width) * 500, 0);
      expect(reveals[0]!.y).toBeCloseTo(((clickY - bounds.y) / bounds.height) * 700, 0);
    }
    expect(errors).toEqual([]);
  });
}

test('selection spans pages and refreshed PDFs replace old text', async ({ page }, testInfo) => {
  let text = firstLine;
  await page.route('**/api/worktrees/session/media?*', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: documentPdf(text) }),
  );
  await page.goto(`${origin}/e2e/fixtures/view-state.html?ordinary`);
  const first = page.locator('[data-pdf-page="1"]').getByText(firstLine, { exact: true });
  const last = page.locator('[data-pdf-page="2"]').getByText('Second page text.', { exact: true });
  await expect(first).toBeVisible();
  await expect(last).toBeAttached();
  await page.evaluate(() => {
    const first = document.querySelector('[data-pdf-page="1"] .pdf-text-layer span')!;
    const last = document.querySelector('[data-pdf-page="2"] .pdf-text-layer span')!;
    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(last.firstChild!, last.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect
    .poll(async () => (await copySelection(page)).replace(/\s+/g, ' '))
    .toBe(`${firstLine} ${secondLine} Second page text.`);

  text = 'Updated PDF text.';
  await page.getByRole('button', { name: 'Recompile' }).click();
  const updated = page.getByText(text, { exact: true });
  await expect(updated).toBeVisible();
  await expect(first).toHaveCount(0);
  await dragLines(page, updated, updated);
  await expect.poll(() => copySelection(page)).toBe(text);
  await page.getByRole('region', { name: 'PDF document' }).evaluate((element) => {
    element.parentElement!.parentElement!.style.width = '480px';
  });
  await expect
    .poll(() => page.locator('[data-pdf-page="1"]').evaluate((element) => element.clientWidth))
    .toBe(448);
  await dragLines(page, updated, updated);
  await expect.poll(() => copySelection(page)).toBe(text);
  await page.screenshot({ path: testInfo.outputPath('pdf-text-selection.png') });
});

test('rotated pages keep their selectable text over the painted glyphs', async ({ page }) => {
  await page.route('**/api/worktrees/session/media?*', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: documentPdf() }),
  );
  await page.goto(`${origin}/e2e/fixtures/view-state.html?ordinary`);
  for (const pageNumber of [3, 4, 5]) {
    const pdfPage = page.locator(`[data-pdf-page="${pageNumber}"]`);
    await pdfPage.scrollIntoViewIfNeeded();
    const text = pdfPage.getByText('Second page text.', { exact: true });
    await expect(text).toBeVisible();
    // Every painted glyph should fall within a text span, even when rotated.
    await expect
      .poll(() =>
        pdfPage.evaluate((element) => {
          const canvas = element.querySelector('canvas')!;
          const bounds = canvas.getBoundingClientRect();
          const spans = [...element.querySelectorAll('.pdf-text-layer span')].map((span) =>
            span.getBoundingClientRect(),
          );
          const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
          let ink = 0;
          let covered = 0;
          for (let pixel = 0; pixel < data.length; pixel += 4) {
            if (data[pixel + 3]! < 128 || data[pixel]! > 128) continue;
            ink++;
            const x = bounds.left + (((pixel / 4) % canvas.width) / canvas.width) * bounds.width;
            const y =
              bounds.top + (Math.floor(pixel / 4 / canvas.width) / canvas.height) * bounds.height;
            if (
              spans.some(
                (span) =>
                  x >= span.left - 1 &&
                  x <= span.right + 1 &&
                  y >= span.top - 1 &&
                  y <= span.bottom + 1,
              )
            )
              covered++;
          }
          return ink ? covered / ink : 0;
        }),
      )
      .toBeGreaterThan(0.98);
    await text.dblclick();
    const selected = await page.evaluate(() => window.getSelection()?.toString());
    expect(selected).toMatch(/\w+/);
    await expect.poll(() => copySelection(page)).toBe(selected);
  }
});
