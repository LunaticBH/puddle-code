/** Confirmed device subscriptions; avoids a second live alert beside the same Web Push. */
const ready = new Set<string>();
export function setRemotePushReady(scope: string, enabled: boolean): void {
  if (enabled) {
    ready.add(scope);
    if (ready.size > 128) ready.delete(ready.values().next().value!);
  } else ready.delete(scope);
}
export const remotePushReady = (scope: string | undefined): boolean => !!scope && ready.has(scope);
