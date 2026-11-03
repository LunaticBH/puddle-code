/** Lower-case extension without a dot, or null for an extensionless/dot file. */
export function sourceExtension(path: string): string | null {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Whether any available daemon provider claims this source path. */
export function isCompilableSource(path: string, extensions: ReadonlySet<string>): boolean {
  const extension = sourceExtension(path);
  return extension !== null && extensions.has(extension);
}

/** Stable browser-local identity for one provider-backed source tab. */
export function compilationSourceKey(session: string, path: string, root?: string): string {
  return `${session}\0${root ?? ''}\0${path}`;
}
