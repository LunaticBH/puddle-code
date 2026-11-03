import { describe, expect, it } from 'vitest';
import { collectPastedFiles, hasPastedFiles } from '../../src/features/explorer/drop-files';

function item(
  file: File | null,
  options: { entry?: FileSystemEntry | null; mime?: string } = {},
): DataTransferItem {
  return {
    kind: 'file',
    type: options.mime ?? file?.type ?? '',
    getAsFile: () => file,
    webkitGetAsEntry: () => options.entry ?? null,
  } as unknown as DataTransferItem;
}

function itemList(...items: DataTransferItem[]): DataTransferItemList {
  return items as unknown as DataTransferItemList;
}

function fileList(...files: File[]): FileList {
  return files as unknown as FileList;
}

const PASTED_AT = new Date(2026, 8, 10, 0, 5, 45, 405);

describe('clipboard file paste', () => {
  it('detects native files without mistaking text for a file paste', () => {
    const png = new File(['pixels'], 'image.png', { type: 'image/png' });
    const text = { kind: 'string', type: 'text/plain' } as DataTransferItem;

    expect(hasPastedFiles(itemList(item(png)), fileList())).toBe(true);
    expect(hasPastedFiles(itemList(text), fileList())).toBe(false);
    expect(hasPastedFiles(undefined, fileList(png))).toBe(true);
  });

  it('names a raw clipboard image after the local time of the paste', async () => {
    // Chromium can leave File.type blank while the clipboard item still carries
    // the MIME type, so exercise that path as well as the filename convention.
    const png = new File(['pixels'], 'image.png', { lastModified: 12 });
    const [collected] = await collectPastedFiles(
      itemList(item(png, { mime: 'image/png' })),
      fileList(),
      true,
      PASTED_AT,
    );

    expect(collected?.name).toBe('Screenshot 2026-09-10 at 00.05.45.405.png');
    expect(collected?.type).toBe('image/png');
    expect(collected?.lastModified).toBe(12);
    expect(await collected?.text()).toBe('pixels');
  });

  it('suffixes multiple clipboard images and derives their extensions from MIME', async () => {
    const png = new File(['one'], 'image.png', { type: 'image/png' });
    const jpeg = new File(['two'], 'image.jpeg', { type: 'image/jpeg' });
    const collected = await collectPastedFiles(
      itemList(item(png), item(jpeg)),
      fileList(),
      true,
      PASTED_AT,
    );

    expect(collected.map((file) => file.name)).toEqual([
      'Screenshot 2026-09-10 at 00.05.45.405.png',
      'Screenshot 2026-09-10 at 00.05.45.405 (2).jpg',
    ]);
  });

  it('timestamps an image even when the browser exposes a filesystem entry', async () => {
    const png = new File(['pixels'], 'diagram.png', { type: 'image/png' });
    const entry = { isFile: true, isDirectory: false } as FileSystemEntry;
    const collected = await collectPastedFiles(
      itemList(item(png, { entry })),
      fileList(),
      true,
      PASTED_AT,
    );

    expect(collected[0]?.name).toBe('Screenshot 2026-09-10 at 00.05.45.405.png');
  });

  it('keeps the real name of a pasted non-image file', async () => {
    const markdown = new File(['notes'], 'notes.md', { type: 'text/markdown' });
    const collected = await collectPastedFiles(
      itemList(item(markdown)),
      fileList(),
      true,
      PASTED_AT,
    );

    expect(collected[0]).toBe(markdown);
    expect(collected[0]?.name).toBe('notes.md');
  });

  it('timestamps an image exposed only through clipboardData.files', async () => {
    const png = new File(['pixels'], 'image.png', { type: 'image/png' });
    const collected = await collectPastedFiles(undefined, fileList(png), true, PASTED_AT);

    expect(collected[0]?.name).toBe('Screenshot 2026-09-10 at 00.05.45.405.png');
  });
});
