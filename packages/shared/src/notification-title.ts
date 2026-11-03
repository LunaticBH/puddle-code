import type { Project } from './api/workspace/projects.js';
import { projectAbbrev } from './project-abbrev.js';

/** One bounded title for both live browser alerts and encrypted background push. */
export function projectNotificationTitle(
  title: string,
  project: Pick<Project, 'name' | 'abbrev'>,
): string {
  return `[${projectAbbrev(project)}] ${title}`.slice(0, 160);
}
