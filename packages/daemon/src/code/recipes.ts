import { commandTemplate } from '../compilation/command-template.js';

export interface CodeRecipe {
  id: string;
  name: string;
  extensions: string[];
  inputs?: string[];
  executables: string[];
  /** Windows names in place of `executables`, where the usual names differ. */
  windowsExecutables?: string[];
  args: string[];
  /** A compiler produces {{binary}}, which is run only after a successful build. */
  compiled?: boolean;
  notebook?: boolean;
}

/** Single-file recipes; project builds remain explicit per-file command overrides. */
export const CODE_RECIPES: readonly CodeRecipe[] = [
  {
    id: 'python',
    name: 'Python',
    extensions: ['py', 'pyw'],
    executables: ['python3', 'python'],
    // python.org installs only python.exe, and python3.exe is usually the
    // Microsoft Store redirector. The py launcher takes the same arguments.
    windowsExecutables: ['python', 'py', 'python3'],
    args: ['-u', '{{source}}'],
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    extensions: ['js', 'mjs', 'cjs'],
    executables: ['node', 'bun'],
    args: ['{{source}}'],
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['ts', 'mts', 'cts', 'tsx'],
    executables: ['tsx', 'bun'],
    args: ['{{source}}'],
  },
  {
    id: 'c',
    name: 'C',
    extensions: ['c'],
    inputs: ['c', 'h'],
    executables: ['cc', 'clang', 'gcc', 'tcc', 'icc', 'icx'],
    // Windows has no cc, and Intel's compilers there are MSVC-style drivers
    // that do not take -o.
    windowsExecutables: ['gcc', 'clang', 'tcc'],
    args: ['{{source}}', '-o', '{{binary}}'],
    compiled: true,
  },
  {
    id: 'cpp',
    name: 'C++',
    extensions: ['cpp', 'cc', 'cxx'],
    inputs: ['cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx'],
    executables: ['c++', 'clang++', 'g++', 'icpx', 'icpc'],
    windowsExecutables: ['g++', 'clang++'],
    args: ['{{source}}', '-o', '{{binary}}'],
    compiled: true,
  },
  {
    id: 'rust',
    name: 'Rust',
    extensions: ['rs'],
    executables: ['rustc'],
    args: ['{{source}}', '-o', '{{binary}}'],
    compiled: true,
  },
  { id: 'go', name: 'Go', extensions: ['go'], executables: ['go'], args: ['run', '{{source}}'] },
  { id: 'ruby', name: 'Ruby', extensions: ['rb'], executables: ['ruby'], args: ['{{source}}'] },
  { id: 'perl', name: 'Perl', extensions: ['pl'], executables: ['perl'], args: ['{{source}}'] },
  { id: 'r', name: 'R', extensions: ['r'], executables: ['Rscript'], args: ['{{source}}'] },
  {
    id: 'shell',
    name: 'Shell',
    extensions: ['sh', 'bash'],
    executables: ['bash'],
    args: ['{{source}}'],
  },
  { id: 'zsh', name: 'Zsh', extensions: ['zsh'], executables: ['zsh'], args: ['{{source}}'] },
  {
    id: 'notebook',
    name: 'Jupyter notebook',
    extensions: ['ipynb'],
    executables: ['jupyter-nbconvert'],
    args: [
      '--to',
      'notebook',
      '--execute',
      '--ExecutePreprocessor.timeout=120',
      '--output',
      'notebook.ipynb',
      '--output-dir',
      '{{output_dir}}',
      '{{source}}',
    ],
    notebook: true,
  },
];

/** The executable names a recipe looks for on `platform`, in order of preference. */
export function recipeExecutables(
  recipe: CodeRecipe,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === 'win32'
    ? (recipe.windowsExecutables ?? recipe.executables)
    : recipe.executables;
}

/** The managed build product's file name: Windows only runs a binary named `.exe`. */
export function managedBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'programme.exe' : 'programme';
}

export function recipeCommand(recipe: CodeRecipe, executable: string): string {
  return commandTemplate(executable, recipe.args);
}
