import { profileSettingsSchema, type Project } from '@puddle/shared';
import { orderByDrag } from '../workspace/sessions/session-order';

/** Keep each profile's projects in the same saved order as its desktop dashboard. */
export async function loadOrderedProjects(
  projects: readonly Project[],
  read: (path: string) => Promise<unknown>,
): Promise<Project[]> {
  const profiles = new Set(projects.map((project) => project.profile_id));
  const ordered: Project[] = [];
  // Serial reads leave room for terminal/control traffic within the remote request limit.
  for (const profile of profiles) {
    const settings = profileSettingsSchema.parse(await read(`/api/profiles/${profile}/settings`));
    ordered.push(
      ...orderByDrag(
        projects.filter((project) => project.profile_id === profile),
        settings.projectOrder ?? [],
      ),
    );
  }
  return ordered;
}
