import { createContext } from 'react';
import type { CompilationFileTarget } from '@puddle/shared';

export const NotebookRenderingContext = createContext<
  (CompilationFileTarget & { onOpenFile?: (path: string) => void; intelligence?: boolean }) | null
>(null);
