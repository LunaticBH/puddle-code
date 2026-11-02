import { isStorageFull } from '../storage/errors.js';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CONCURRENT_TEMPLATE,
  DEFAULT_ONBOARDING_TEMPLATE,
  DEFAULT_RESTART_TEMPLATE,
  RULES_TOKEN,
} from '@puddle/shared';
import type { EventStore } from '../db/stores/events.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';

/**
 * Onboarding preamble for freshly created worktrees (SPEC §4). `template` is the
 * profile's launch text: `undefined` falls back to DEFAULT_ONBOARDING_TEMPLATE,
 * an empty string is an intentional empty preamble. Any `{{rules}}` token is
 * replaced with the repo's standing rules (`notes`), and the task prompt is
 * appended after a `---` divider. Sessions reusing an existing worktree (resume,
 * hand-off) never receive this.
 */
export function buildOnboardingPreamble(
  template: string | undefined,
  notes: string | null,
  taskPrompt?: string | null,
): string {
  const rules = notes?.trim() ? notes.trim() : '(none recorded yet — everything is discretionary)';
  const body = (template ?? DEFAULT_ONBOARDING_TEMPLATE).split(RULES_TOKEN).join(rules);
  return appendTaskPrompt(body, taskPrompt);
}

/**
 * Prepended when a session attaches to an *existing* shared worktree
 * (separate_branch = false, SPEC §4): the branch and its working tree already
 * exist because other sessions are on them, so this agent is working
 * concurrently with others. `template` follows the same undefined/empty rules as
 * the onboarding preamble.
 */
export function buildConcurrentWorktreeNote(
  template: string | undefined,
  taskPrompt?: string | null,
): string {
  return appendTaskPrompt(template ?? DEFAULT_CONCURRENT_TEMPLATE, taskPrompt);
}

/**
 * Appends the user's task prompt after a `---` divider. An empty body (a
 * cleared template) yields just the prompt; when both are empty the result is
 * the empty string, and the caller passes no initial prompt to the agent.
 */
function appendTaskPrompt(body: string, taskPrompt?: string | null): string {
  const prompt = taskPrompt?.trim() ? taskPrompt : '';
  if (body.trim() === '') return prompt;
  return prompt ? `${body}\n\n---\n\n${prompt}` : body;
}

/**
 * Launch text sent when a session resumes after an interruption — a daemon
 * restart or a machine reboot (SPEC §4). `template` is the profile's
 * `restartTemplate`: `undefined` falls back to DEFAULT_RESTART_TEMPLATE, an
 * empty string is an intentional empty note (the caller then sends no prompt).
 */
export function buildInterruptedResumeNote(template: string | undefined): string {
  return template ?? DEFAULT_RESTART_TEMPLATE;
}

/**
 * Watches each live session's `.puddle/onboarding-notes.md` and syncs it into
 * repos.onboarding_notes (last-writer-wins; the previous notes are preserved in
 * an event row so an unwanted overwrite is inspectable — SPEC §4). Session
 * naming is NOT done here: a session's default name is the agent's own session
 * name (adapter.sessionTitle), so a `.puddle/session-title` file — which would
 * collide when several agents share one worktree — is no longer used.
 */
export class MarkerFileSync {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: { repos: RepoStore; events: EventStore; sessions: SessionStore },
  ) {}

  watch(sessionId: string, repoId: number, worktreePath: string): void {
    if (this.watchers.has(sessionId)) return;
    const dir = join(worktreePath, '.puddle');
    if (!existsSync(dir)) return;
    try {
      const watcher = watch(dir, () => this.schedule(sessionId, repoId, dir));
      watcher.on('error', () => this.unwatch(sessionId));
      this.watchers.set(sessionId, watcher);
    } catch {
      // A vanished dir between the check and the watch is not fatal.
    }
  }

  unwatch(sessionId: string): void {
    this.watchers.get(sessionId)?.close();
    this.watchers.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  dispose(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  private schedule(sessionId: string, repoId: number, dir: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        try {
          this.sync(sessionId, repoId, dir);
        } catch (error) {
          if (!isStorageFull(error)) throw error;
        }
      }, 300),
    );
  }

  private sync(sessionId: string, repoId: number, dir: string): void {
    this.syncNotes(sessionId, repoId, dir);
  }

  private syncNotes(sessionId: string, repoId: number, dir: string): void {
    const file = join(dir, 'onboarding-notes.md');
    if (!existsSync(file)) return;
    let next: string;
    try {
      next = readFileSync(file, 'utf8').trim();
    } catch {
      return;
    }
    const repo = this.deps.repos.get(repoId);
    if (next === '' || next === (repo.onboarding_notes ?? '').trim()) return;
    this.deps.events.record(sessionId, 'onboarding_notes_updated', {
      previous: repo.onboarding_notes,
    });
    this.deps.repos.setOnboardingNotes(repoId, next);
  }
}
