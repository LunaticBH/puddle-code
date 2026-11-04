import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/lib/transport/api';
import {
  invalidNameMessage,
  windowsRefusalMessage,
} from '../../../src/lib/transport/windows-refusals';

/** The daemon's error envelope as `api()` raises it. */
const refusal = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);

describe('windowsRefusalMessage', () => {
  it('names the entry and the rule for a name Windows cannot store', () => {
    // worktree-shared.ts assertStorableName, with windowsNameProblem's wording.
    expect(
      windowsRefusalMessage(
        refusal(
          400,
          'invalid_name',
          `'src/a:b.ts' cannot be created: Windows names cannot contain < > : " | ? * or control characters`,
        ),
      ),
    ).toBe(
      `Can't use the name 'src/a:b.ts': Windows names cannot contain < > : " | ? * or control characters.`,
    );
    expect(
      windowsRefusalMessage(
        refusal(
          400,
          'invalid_name',
          `'CON' cannot be created: 'CON' is a reserved device name on Windows`,
        ),
      ),
    ).toBe(`Can't use the name 'CON': 'CON' is a reserved device name on Windows.`);
  });

  it('leaves the untitled-draft invalid_name every host sends alone', () => {
    expect(
      windowsRefusalMessage(refusal(400, 'invalid_name', 'not an untitled draft name')),
    ).toBeNull();
  });

  it('says another program holds an entry open, and what to do', () => {
    expect(
      windowsRefusalMessage(
        refusal(
          409,
          'path_busy',
          'src/app.log is in use by another program (a terminal, editor or dev server); close it and try again',
        ),
      ),
    ).toBe(
      "'src/app.log' is open in another program (a terminal, editor or dev server), so Windows can't move or delete it. Close it there and try again.",
    );
    // The root itself ('.'), or a message of another shape.
    for (const message of [
      '. is in use by another program (a terminal, editor or dev server); close it and try again',
      'busy',
    ]) {
      expect(windowsRefusalMessage(refusal(409, 'path_busy', message))).toMatch(
        /^This item is open in another program/,
      );
    }
  });

  it('explains a worktree held open on Windows, but not the running-sessions refusal', () => {
    expect(
      windowsRefusalMessage(
        refusal(
          409,
          'worktree_busy',
          'files in C:\\Users\\a\\wt are open in another program (a terminal, agent, editor or dev server) — close them and try again',
        ),
      ),
    ).toBe(
      "Windows can't remove this worktree while files in it are open in another program (a terminal, agent, editor or dev server). Close them, then remove the worktree again.",
    );
    // repos.ts on every host: its message already says what to do.
    expect(
      windowsRefusalMessage(
        refusal(
          409,
          'worktree_busy',
          '1 running session(s) still use this worktree — stop them first',
        ),
      ),
    ).toBeNull();
  });

  it("passes on git's safe.directory advice for an unsafe repository", () => {
    const stderr =
      "fatal: detected dubious ownership in repository at 'D:/repo'\n" +
      "'D:/repo' is owned by:\n\tBUILTIN/Administrators (S-1-5-32-544)\n" +
      'but the current user is:\n\tPC/alice (S-1-5-21-1)\n' +
      "To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory 'D:/repo'";
    expect(windowsRefusalMessage(refusal(400, 'unsafe_repository', stderr))).toBe(
      "Git refuses to open 'D:/repo' because another user owns it. If you trust it, run this on the host, then try again: git config --global --add safe.directory 'D:/repo'",
    );
    // Without git's advice (a trimmed or localised message), the step is still named.
    expect(windowsRefusalMessage(refusal(400, 'unsafe_repository', 'fatal: unsafe'))).toBe(
      "Git refuses to open this repository because another user owns it. If you trust it, add it to git's safe.directory list on the host, then try again.",
    );
  });

  it('returns null for every other error, so callers keep their own wording', () => {
    expect(windowsRefusalMessage(refusal(404, 'not_found', 'worktree not found'))).toBeNull();
    expect(windowsRefusalMessage(refusal(409, 'worktree_dirty', 'dirty'))).toBeNull();
    expect(windowsRefusalMessage(new Error('path_busy'))).toBeNull();
    expect(windowsRefusalMessage('invalid_name')).toBeNull();
    expect(windowsRefusalMessage(undefined)).toBeNull();
  });
});

describe('invalidNameMessage', () => {
  it('names the entry, then the rule', () => {
    expect(invalidNameMessage('notes.', 'Windows names cannot end in a dot or a space')).toBe(
      "Can't use the name 'notes.': Windows names cannot end in a dot or a space.",
    );
  });
});
