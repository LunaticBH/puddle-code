import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { editor } from 'monaco-editor';
import type { Terminal } from '@xterm/xterm';

declare global {
  interface Window {
    viewFixture: {
      editor(): editor.ICodeEditor;
      diff(): editor.IStandaloneDiffEditor;
      terminal(): Terminal | undefined;
    };
  }
}

test.use({ viewport: { width: 1000, height: 800 } });
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

test.beforeEach(async ({ page }) => {
  await page.route(`${origin}/api/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/file'))
      return route.fulfill({
        json: {
          path: 'file.txt',
          binary: false,
          mtime_ms: 1,
          content: Array.from(
            { length: 300 },
            (_, index) => `Line ${index + 1}: ${'content '.repeat(20)}`,
          ).join('\n'),
        },
      });
    if (path.endsWith('/version'))
      return route.fulfill({ json: { protocol: { major: 22, minor: 0 } } });
    return route.fulfill({ json: {} });
  });
});

/** Small, valid PDF with unequal page sizes: exercise actual PDF.js geometry and its worker. */
function documentPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>',
    ...[700, 950, 600, 850].map(
      (height) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 ${height}] /Resources << >> /Contents 7 0 R >>`,
    ),
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
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

for (const ordinary of [false, true])
  test(`${ordinary ? 'ordinary' : 'LaTeX'} PDF scroll and zoom survive project switches and refreshed output`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/worktrees/session/media?*', (route) =>
      route.fulfill({ contentType: 'application/pdf', body: documentPdf() }),
    );
    await page.goto(`${origin}/e2e/fixtures/view-state.html${ordinary ? '?ordinary' : ''}`);
    const scroller = page.getByRole('region', { name: 'PDF document' });
    await expect(page.locator('[data-scroll-ready="true"]')).toHaveCount(4);
    await expect(page.locator('[data-pdf-page][title]')).toHaveCount(ordinary ? 0 : 4);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Zoom 125%; reset to fit width' })).toBeVisible();
    await scroller.evaluate((element) => {
      element.scrollTop = 1900;
      element.scrollLeft = 100;
    });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(1900);
    await page.getByRole('button', { name: 'Second project' }).click();
    await expect(page.locator('[data-scroll-ready="true"]')).toHaveCount(4);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
    await scroller.evaluate((element) => {
      element.scrollTop = 450;
    });
    await page.getByRole('button', { name: 'First project' }).click();
    await expect(page.getByRole('button', { name: 'Zoom 125%; reset to fit width' })).toBeVisible();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(1900);
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(100);
    await page.getByRole('button', { name: 'Recompile' }).click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(1900);
    await page.getByRole('button', { name: 'Second project' }).click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(450);
    expect(errors).toEqual([]);
  });

for (const kind of [
  'markdown',
  'html',
  'code',
  'private',
  'diff',
  'terminal',
  'parked-terminal',
  'phone-source',
]) {
  test(`${kind} restores its own position after switching projects`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/e2e/fixtures/view-state.html?view=${kind}`);
    await expect
      .poll(() => (errors.length ? errors : page.evaluate(() => Boolean(window.viewFixture))), {
        timeout: 15_000,
      })
      .toBe(true);
    const scroll = async (position?: number): Promise<number> => {
      if (kind === 'html')
        return page
          .frameLocator('iframe')
          .locator('body')
          .evaluate((_body, top) => {
            if (top !== undefined) window.scrollTo(0, top);
            return window.scrollY;
          }, position);
      if (kind === 'markdown' || kind === 'phone-source')
        return page.locator('.overflow-auto').evaluate((element, top) => {
          if (top !== undefined) element.scrollTop = top;
          return element.scrollTop;
        }, position);
      return page.evaluate(
        ({ kind, position }) => {
          if (kind.endsWith('terminal')) {
            const terminal = window.viewFixture?.terminal();
            if (!terminal || terminal.buffer.active.baseY < 100) return -1;
            if (position !== undefined) terminal.scrollToLine(position);
            return terminal.buffer.active.viewportY;
          }
          const editor =
            kind === 'diff'
              ? window.viewFixture?.diff()?.getModifiedEditor()
              : window.viewFixture?.editor();
          if (!editor?.getDomNode()?.isConnected) return -1;
          if (position !== undefined) editor.setScrollTop(position);
          return editor.getScrollTop();
        },
        { kind, position },
      );
    };
    const position = kind.endsWith('terminal') ? 80 : 1800;
    await expect.poll(() => scroll(position)).toBe(position);
    // Allow browser scroll reports and Monaco's asynchronous diff layout to settle.
    await page.waitForTimeout(100);
    await page.getByRole('button', { name: 'Second project' }).click();
    await expect.poll(() => scroll()).not.toBe(-1);
    await expect.poll(() => scroll()).not.toBe(position);
    const secondPosition = kind.endsWith('terminal') ? 140 : 600;
    await expect.poll(() => scroll(secondPosition)).toBe(secondPosition);
    await page.waitForTimeout(kind === 'parked-terminal' ? 1_800 : 100);
    await page.getByRole('button', { name: 'First project' }).click();
    await expect.poll(() => scroll()).toBe(position);
    await page.getByRole('button', { name: 'Second project' }).click();
    await expect.poll(() => scroll()).toBe(secondPosition);
    expect(errors).toEqual([]);
  });
}

for (const gesture of ['trackpad', 'touch']) {
  test(`PDF ${gesture} pinch keeps the page point beneath the gesture fixed`, async ({ page }) => {
    await page.route('**/api/worktrees/session/media?*', (route) =>
      route.fulfill({ contentType: 'application/pdf', body: documentPdf() }),
    );
    await page.goto(`${origin}/e2e/fixtures/view-state.html`);
    await expect(page.locator('[data-scroll-ready="true"]')).toHaveCount(4);
    const scroller = page.getByRole('region', { name: 'PDF document' });
    const anchor = await scroller.evaluate((element) => {
      const page = element.querySelector<HTMLElement>('[data-pdf-page="2"]')!;
      element.scrollTop +=
        page.getBoundingClientRect().top - element.getBoundingClientRect().top + 100;
      const bounds = element.getBoundingClientRect();
      const rect = page.getBoundingClientRect();
      const clientX = bounds.left + 400;
      const clientY = bounds.top + 280;
      return {
        clientX,
        clientY,
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height,
        width: rect.width,
      };
    });
    if (gesture === 'trackpad') {
      await page.mouse.move(anchor.clientX, anchor.clientY);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -150);
      await page.keyboard.up('Control');
    } else {
      await scroller.evaluate((element, anchor) => {
        const touches = (distance: number) =>
          [-1, 1].map(
            (direction, identifier) =>
              new Touch({
                identifier,
                target: element,
                clientX: anchor.clientX + (direction * distance) / 2,
                clientY: anchor.clientY,
              }),
          );
        element.dispatchEvent(
          new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: touches(100) }),
        );
        element.dispatchEvent(
          new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: touches(160) }),
        );
        element.dispatchEvent(
          new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] }),
        );
      }, anchor);
    }
    const pdfPage = page.locator('[data-pdf-page="2"]');
    await expect
      .poll(() => pdfPage.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(anchor.width);
    await expect
      .poll(() =>
        pdfPage.evaluate((element, anchor) => {
          const rect = element.getBoundingClientRect();
          return Math.max(
            Math.abs(rect.left + anchor.x * rect.width - anchor.clientX),
            Math.abs(rect.top + anchor.y * rect.height - anchor.clientY),
          );
        }, anchor),
      )
      .toBeLessThan(2);
  });
}
