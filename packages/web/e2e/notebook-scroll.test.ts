import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

let server: ViteDevServer;
let origin: string;
test.use({ viewport: { width: 1000, height: 800 } });
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

async function openNotebook(page: Page) {
  await page.route(`${origin}/api/worktrees/**/file?*`, (route) =>
    route.fulfill({
      json: {
        content: JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: { language_info: { name: 'python' } },
          cells: Array.from({ length: 40 }, (_, index) => ({
            id: `cell-${index}`,
            cell_type: 'code',
            metadata: {},
            source: Array.from(
              { length: index === 0 ? 80 : 8 },
              (_, line) => `value_${index}_${line} = ${line}`,
            ).join('\n'),
            outputs: [],
            execution_count: null,
          })),
        }),
        binary: false,
        mtime_ms: 1,
      },
    }),
  );
  await page.route(`${origin}/api/version`, (route) =>
    route.fulfill({ json: { protocol: { major: 24, minor: 0 } } }),
  );
  await page.goto(`${origin}/e2e/fixtures/notebook.html`);
  await expect(page.locator('[data-cell-id="cell-0"] .view-lines')).toContainText('value_0_0');
  return page.locator('.overflow-auto').filter({ has: page.locator('[data-cell-id="cell-0"]') });
}

test('keeps the requested position while newly visible editors measure their content', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const scroller = await openNotebook(page);
  await page.waitForTimeout(300);
  for (const top of [6000, 10000, 3000, 0, 7000, 500]) {
    await scroller.evaluate((element, top) => {
      element.scrollTop = top;
    }, top);
    await page.waitForTimeout(300);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(top);
    const visible = await scroller.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>('[data-cell-id]')]
        .filter((cell) => {
          const rect = cell.getBoundingClientRect();
          return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
        })
        .map((cell) => ({
          id: cell.dataset.cellId,
          text: cell.querySelector('.view-lines')?.textContent,
        }));
    });
    for (const cell of visible) expect(cell.text).toContain(`value_${cell.id!.slice(5)}_0`);
  }
  expect(errors).toEqual([]);
});

test('lets wheel gestures cross a tall code cell without scrolling its source internally', async ({
  page,
}) => {
  const scroller = await openNotebook(page);
  const cell = page.locator('[data-cell-id="cell-0"]');
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  expect(
    await cell
      .locator('.monaco-scrollable-element')
      .first()
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
});

test('keeps the reading cell fixed when source below it grows and restores it after switching tabs', async ({
  page,
}) => {
  const scroller = await openNotebook(page);
  await scroller.evaluate((element) => {
    element.scrollTop = 7000;
  });
  await page.waitForTimeout(300);
  const before = await scroller.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const cell = [...element.querySelectorAll<HTMLElement>('[data-cell-id]')].find(
      (cell) => cell.getBoundingClientRect().top >= top,
    )!;
    return {
      id: cell.dataset.cellId!,
      offset: cell.getBoundingClientRect().top - top,
      scrollTop: element.scrollTop,
    };
  });
  await page.evaluate((id) => {
    const editors = window.notebookFixture.monaco.editor.getEditors();
    const editor = editors.find(
      (editor) =>
        editor.getDomNode()?.closest('[data-cell-id]')?.getAttribute('data-cell-id') === id,
    )!;
    const model = editor.getModel()!;
    model.pushEditOperations(
      [],
      [
        {
          range: model.getFullModelRange(),
          text: `${model.getValue()}\n${'added = 1\n'.repeat(30)}`,
        },
      ],
      () => null,
    );
  }, before.id);
  await page.waitForTimeout(300);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before.scrollTop);
  await page.getByText('paper.tex', { exact: true }).click();
  await page.getByText('analysis.ipynb', { exact: true }).click();
  await expect(page.locator(`[data-cell-id="${before.id}"] .view-lines`)).toContainText('added');
  await page.waitForTimeout(300);
  expect(
    await scroller.evaluate((element, id) => {
      return (
        element.querySelector(`[data-cell-id="${id}"]`)!.getBoundingClientRect().top -
        element.getBoundingClientRect().top
      );
    }, before.id),
  ).toBe(before.offset);
});

test('resizes wrapped source, retains focus and undo across viewport eviction, and releases editors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const scroller = await openNotebook(page);
  const first = page.locator('[data-cell-id="cell-0"]');
  await first.locator('.monaco-editor').click({ position: { x: 80, y: 20 } });
  await page.keyboard.press('ControlOrMeta+A');
  const longLine = `# ${'readable source '.repeat(30)}`;
  await page.evaluate((text) => {
    const editor = window.notebookFixture.monaco.editor
      .getEditors()
      .find((editor) => editor.hasTextFocus())!;
    editor.pushUndoStop();
    editor.executeEdits('notebook-regression', [
      { range: editor.getModel()!.getFullModelRange(), text },
    ]);
    editor.pushUndoStop();
  }, longLine);
  const originalModel = await page.evaluate(() => {
    const editor = window.notebookFixture.monaco.editor
      .getEditors()
      .find((editor) => editor.hasTextFocus())!;
    return { uri: editor.getModel()!.uri.toString(), canUndo: editor.getModel()!.canUndo() };
  });
  expect(originalModel.canUndo).toBe(true);
  await page.evaluate(() =>
    window.notebookFixture.settings({ editorWordWrap: true, editorFontSize: 20 }),
  );
  await page.setViewportSize({ width: 650, height: 800 });
  await expect
    .poll(() => first.locator('.monaco-editor').evaluate((element) => element.clientWidth))
    .toBeLessThan(600);
  await page.waitForTimeout(100);
  await expect.poll(() => first.locator('.view-line').count()).toBeGreaterThan(5);
  const height = await first.locator('.monaco-editor').evaluate((element) => element.clientHeight);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect
    .poll(() => first.locator('.monaco-editor').evaluate((element) => element.clientHeight))
    .toBeLessThan(height);
  await scroller.evaluate((element) => {
    element.scrollTop = 6000;
  });
  await page.waitForTimeout(300);
  // A clicked editor must stay alive while it owns keyboard focus.
  await expect(first.locator('.monaco-editor')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save notebook', exact: true }).focus();
  await expect(first.locator('.monaco-editor')).toHaveCount(0);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(first.locator('.view-lines')).toContainText('readable');
  await first.locator('.monaco-editor').click({ position: { x: 80, y: 20 } });
  expect(
    await page.evaluate(() => {
      const editor = window.notebookFixture.monaco.editor
        .getEditors()
        .find((editor) => editor.hasTextFocus())!;
      return { uri: editor.getModel()!.uri.toString(), canUndo: editor.getModel()!.canUndo() };
    }),
  ).toEqual(originalModel);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(first.locator('.view-lines')).toContainText('value_0_0');
  await page.getByText('paper.tex', { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.notebookFixture.monaco.editor.getEditors().length))
    .toBe(1);
  expect(errors).toEqual([]);
});
