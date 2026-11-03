import { describe, expect, it } from 'vitest';
import {
  compilationSupported,
  compilationDefaultsSupported,
  notebookKernelsSupported,
  notebookWidgetsSupported,
  compilationSettingsSupported,
  crossFiletreeTransferSupported,
  dynamicBaseBranchSupported,
  nativeConversationSyncSupported,
  projectColourSupported,
} from '../../../src/lib/transport/protocol-support';

describe('project colour compatibility gate', () => {
  it('requires a host that can save project colours', () => {
    expect(projectColourSupported(undefined)).toBe(false);
    expect(projectColourSupported({ major: 24, minor: 4 })).toBe(false);
    expect(projectColourSupported({ major: 24, minor: 5 })).toBe(true);
    expect(projectColourSupported({ major: 25, minor: 0 })).toBe(true);
  });
});

describe('dynamic repository default compatibility gate', () => {
  it('allows clearing the default only from protocol 21.3', () => {
    expect(dynamicBaseBranchSupported(undefined)).toBe(false);
    expect(dynamicBaseBranchSupported({ major: 21, minor: 2 })).toBe(false);
    expect(dynamicBaseBranchSupported({ major: 21, minor: 3 })).toBe(true);
    expect(dynamicBaseBranchSupported({ major: 22, minor: 0 })).toBe(true);
  });
});

describe('cross-filetree transfer compatibility gate', () => {
  it('stays disabled until protocol 16.3 is positively identified', () => {
    expect(crossFiletreeTransferSupported(undefined)).toBe(false);
    expect(crossFiletreeTransferSupported({ major: 16, minor: 2 })).toBe(false);
    expect(crossFiletreeTransferSupported({ major: 16, minor: 3 })).toBe(true);
    expect(crossFiletreeTransferSupported({ major: 17, minor: 0 })).toBe(true);
  });
});

describe('compilation compatibility gate', () => {
  it('requires confirmed protocol 25.4 for live widget comms', () => {
    expect(notebookWidgetsSupported(undefined)).toBe(false);
    expect(notebookWidgetsSupported({ major: 25, minor: 3 })).toBe(false);
    expect(notebookWidgetsSupported({ major: 25, minor: 4 })).toBe(true);
  });
  it('requires confirmed protocol 24.6 for persistent notebook controls', () => {
    expect(notebookKernelsSupported(undefined)).toBe(false);
    expect(notebookKernelsSupported({ major: 24, minor: 5 })).toBe(false);
    expect(notebookKernelsSupported({ major: 24, minor: 6 })).toBe(true);
  });
  it('requires confirmed protocol 24.4 for language defaults', () => {
    expect(compilationDefaultsSupported(undefined)).toBe(false);
    expect(compilationDefaultsSupported({ major: 24, minor: 3 })).toBe(false);
    expect(compilationDefaultsSupported({ major: 24, minor: 4 })).toBe(true);
    expect(compilationDefaultsSupported({ major: 25, minor: 0 })).toBe(true);
  });
  it('enables host-side providers from protocol 17.1', () => {
    expect(compilationSupported({ major: 17, minor: 0 })).toBe(false);
    expect(compilationSupported({ major: 17, minor: 1 })).toBe(true);
    expect(compilationSupported({ major: 18, minor: 0 })).toBe(true);
  });

  it('enables per-file command settings from protocol 17.3', () => {
    expect(compilationSettingsSupported({ major: 17, minor: 2 })).toBe(false);
    expect(compilationSettingsSupported({ major: 17, minor: 3 })).toBe(true);
    expect(compilationSettingsSupported({ major: 18, minor: 0 })).toBe(true);
  });
});

describe('native conversation compatibility gate', () => {
  it('enables activation refresh only from protocol 16.4', () => {
    expect(nativeConversationSyncSupported({ major: 16, minor: 3 })).toBe(false);
    expect(nativeConversationSyncSupported({ major: 16, minor: 4 })).toBe(true);
    expect(nativeConversationSyncSupported({ major: 17, minor: 0 })).toBe(true);
  });
});
