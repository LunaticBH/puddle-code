import { describe, expect, it } from 'vitest';
import type { NoticeEvent } from '../../src/sessions/service.js';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';

/**
 * Errors must never be silent (SPEC §4). An agent or shell that dies on its
 * own raises a notice the UI shows as a toast, carrying the process's own last
 * output — but a stop we asked for stays quiet, or the notice becomes noise
 * the user learns to ignore.
 */
describe('abnormal-exit notices', () => {
  /** An agent that prints a failure and dies, like a rejected CLI flag. */
  function failingAdapter() {
    // Windows runs the fixture's Node fake agent (no bash), so it dies in Node;
    // exitCode rather than exit(), as console writes there are asynchronous.
    const die =
      process.platform === 'win32'
        ? ['-e', 'console.error("error: unexpected argument \'--yolo\'"); process.exitCode = 2']
        : ['-c', 'echo "error: unexpected argument \'--yolo\'" >&2; exit 2'];
    // Both paths must fail: resume is what the later-crash case exercises.
    return { ...fakeAdapter(), launchArgs: () => die, resumeArgs: () => die };
  }

  function collect(f: ReturnType<typeof fixture>): NoticeEvent[] {
    const seen: NoticeEvent[] = [];
    f.service.on('notice', (n: NoticeEvent) => seen.push(n));
    return seen;
  }

  it('reports an agent that dies at launch, quoting its own output', async () => {
    const f = fixture();
    f.adapters.get('fake'); // registry sanity
    const notices = collect(f);
    // Swap in the failing agent for this fixture's registry.
    Object.assign(f.adapters.get('fake'), failingAdapter());

    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => notices.length > 0, 10_000);

    const notice = notices[0]!;
    expect(notice.level).toBe('error');
    // It never reached `running`, so it is reported as a failure to START.
    expect(notice.title).toContain('failed to start');
    expect(notice.title).toContain('exit 2');
    expect(notice.session).toBe(session.id);
    // The diagnosis is the agent's own words, not a generic message.
    expect(notice.detail).toContain('unexpected argument');
  });

  it('stays silent when the user kills the session', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('READY'), 10_000);

    const notices = collect(f);
    await f.service.kill(session.id);
    // Give any stray notice a chance to arrive before asserting silence.
    await new Promise((r) => setTimeout(r, 300));
    expect(notices).toEqual([]);
  });

  it('stays silent when the user archives a live session', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('READY'), 10_000);

    const notices = collect(f);
    await f.service.archive(session.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(notices).toEqual([]);
  });

  it('does not let a kill silence a later crash on the same session', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('READY'), 10_000);
    await f.service.kill(session.id); // consumes the expected-exit flag

    const notices = collect(f);
    // The next run dies on its own; the earlier kill must not suppress it.
    Object.assign(f.adapters.get('fake'), failingAdapter());
    await f.service.resume(session.id).catch(() => undefined);
    await waitFor(() => notices.length > 0, 10_000);
    expect(notices[0]?.title).toContain('exit 2');
  });
});
