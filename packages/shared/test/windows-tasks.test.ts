import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createWindowsProcess,
  registerWindowsTask,
  runWindowsPowerShell,
  startWindowsTask,
  unregisterWindowsTask,
  WINDOWS_TASK_SCRIPTS,
  windowsProcessElevated,
  windowsTaskState,
  windowsTaskXml,
  type PowerShellRunner,
  type WindowsTaskDefinition,
} from '../src/node/windows-tasks.js';
import {
  canonicalWindowsHome,
  supervisorCommandLine,
  supervisorTaskDefinition,
  supervisorTaskName,
  unschedulableHome,
} from '../src/node/windows-supervision.js';

/** Task Scheduler and WMI through a recorded fake PowerShell; any OS, no real task. */
const SID = 'S-1-5-21-2084319783-4192790293-3383329085-1001';

function fakePowerShell(reply: (env: Readonly<Record<string, string>>) => object | string) {
  const calls: Array<{ script: string; env: Readonly<Record<string, string>>; timeoutMs: number }> =
    [];
  const runner: PowerShellRunner = async (script, env, timeoutMs) => {
    calls.push({ script, env, timeoutMs });
    const answer = reply(env);
    return {
      code: 0,
      stdout: typeof answer === 'string' ? answer : `${JSON.stringify(answer)}\r\n`,
      stderr: '',
    };
  };
  return { runner, calls };
}

const definition = (overrides: Partial<WindowsTaskDefinition> = {}): WindowsTaskDefinition => ({
  description: 'Puddle & <friends> "quoted"',
  userSid: SID,
  command: 'C:\\Users\\a b\\bin\\puddle-hidden.exe',
  arguments: '"C:\\Users\\a b\\x.exe" --home "C:\\Users\\a b"',
  workingDirectory: 'C:\\Users\\a b',
  priority: 4,
  ...overrides,
});

describe('Windows scheduled task definitions', () => {
  it('runs at the user’s logon with their interactive token, indefinitely and at normal priority', () => {
    const xml = windowsTaskXml('Puddle 0123456789abcdef', definition());
    expect(xml).toContain('<URI>\\Puddle 0123456789abcdef</URI>');
    expect(xml).toContain(
      `<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>${SID}</UserId>`,
    );
    expect(xml).toContain(`<UserId>${SID}</UserId>\n      <LogonType>InteractiveToken</LogonType>`);
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<Priority>4</Priority>');
    expect(xml).toContain('<Hidden>false</Hidden>');
    expect(xml).toContain(
      '<Description>Puddle &amp; &lt;friends&gt; &quot;quoted&quot;</Description>',
    );
    expect(xml).toContain('<Command>C:\\Users\\a b\\bin\\puddle-hidden.exe</Command>');
    expect(xml).toContain(
      '<Arguments>&quot;C:\\Users\\a b\\x.exe&quot; --home &quot;C:\\Users\\a b&quot;</Arguments>',
    );
    expect(xml).not.toMatch(/<\?xml/);
  });

  it('refuses a malformed SID or priority rather than writing it into the XML', () => {
    expect(() => windowsTaskXml('t', definition({ userSid: 'S-1-5</UserId>' }))).toThrow('SID');
    expect(() => windowsTaskXml('t', definition({ priority: 11 }))).toThrow('priority');
  });

  it('names one task per home by its private ipc-key, whichever spelling names it', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-task-name-'));
    const name = supervisorTaskName(home);
    expect(name).toMatch(/^Puddle [0-9a-f]{16}$/);
    expect(supervisorTaskName(home)).toBe(name);
    if (process.platform === 'win32') expect(supervisorTaskName(home.toUpperCase())).toBe(name);
    // Never a public hash of the path, which another account could compute and take first.
    const identity = canonicalWindowsHome(home).toLowerCase();
    const hashed = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    expect(name).not.toBe(`Puddle ${hashed}`);
    expect(supervisorTaskName(mkdtempSync(join(tmpdir(), 'puddle-task-name-')))).not.toBe(name);
    // The same path under another key is another name.
    writeFileSync(join(home, 'ipc-key'), 'a'.repeat(64));
    expect(supervisorTaskName(home)).not.toBe(name);
  });

  it('starts the supervisor windowless through the current junction, quoting every path', () => {
    const home = 'C:\\Users\\Zoë Ørsted\\.puddle dev';
    const task = supervisorTaskDefinition(home, SID);
    const current = 'C:\\Users\\Zoë Ørsted\\.puddle dev\\bin\\current';
    expect(task.command).toBe(`${current}\\bin\\puddle-hidden.exe`);
    expect(task.arguments).toBe(
      `"${current}\\bin\\node.exe" "${current}\\daemon\\supervisor.mjs" ` +
        '--home "C:\\Users\\Zoë Ørsted\\.puddle dev"',
    );
    expect(task.priority).toBe(4);
    expect(task.description).toContain(home);
    // A drive-root home keeps its closing quote: the trailing backslash is doubled.
    expect(supervisorTaskDefinition('D:\\', SID).arguments).toMatch(/--home "D:\\\\"$/);
    // WMI runs the same launcher and arguments, the launcher quoted.
    expect(supervisorCommandLine(home)).toBe(`"${task.command}" ${task.arguments}`);
  });

  it('refuses homes whose task command Task Scheduler would expand or split', () => {
    expect(unschedulableHome('C:\\Users\\a\\.puddle')).toBeUndefined();
    expect(unschedulableHome('C:\\100%\\.puddle')).toMatch(/Task Scheduler cannot start Puddle/);
    expect(unschedulableHome('C:\\a"b')).toMatch(/Task Scheduler cannot start Puddle/);
    expect(unschedulableHome('C:\\a\tb')).toMatch(/Task Scheduler cannot start Puddle/);
    expect(unschedulableHome('C:\\a\u007fb')).toMatch(/Task Scheduler cannot start Puddle/);
  });
});

describe('Task Scheduler through PowerShell', () => {
  it('passes the name and XML only in the environment, never in the script', async () => {
    const { runner, calls } = fakePowerShell(() => ({
      registered: true,
      disabled: false,
      ran: true,
      state: 'Running',
      error: '',
    }));
    const name = 'Puddle 0123456789abcdef';
    const task = definition();
    const xml = windowsTaskXml(name, task);
    const action = { command: task.command, arguments: task.arguments };
    expect(
      await registerWindowsTask(name, xml, { powershell: runner, start: true, action }),
    ).toEqual({
      registered: true,
      disabled: false,
      ran: true,
      state: 'running',
    });
    expect(await startWindowsTask(name, { powershell: runner, action })).toMatchObject({
      ran: true,
    });
    const [call, start] = calls;
    expect(call!.env).toMatchObject({
      PUDDLE_TASK_NAME: name,
      PUDDLE_TASK_XML: xml,
      PUDDLE_TASK_START: '1',
      PUDDLE_TASK_COMMAND: task.command,
      PUDDLE_TASK_ARGUMENTS: task.arguments,
    });
    // A start checks what the task runs too.
    expect(start!.env).toMatchObject({
      PUDDLE_TASK_COMMAND: task.command,
      PUDDLE_TASK_ARGUMENTS: task.arguments,
    });
    for (const { script } of calls) {
      expect(script).not.toContain(name);
      expect(script).not.toContain('puddle-hidden');
      expect(script).toContain('function Test-OwnTask');
    }
    expect(call!.script).toContain('Register-ScheduledTask -TaskName $name');
    expect(call!.script).toContain('-Xml $env:PUDDLE_TASK_XML -Force');
  });

  it('asks PowerShell whether this process runs elevated, and assumes not when it cannot tell', async () => {
    const { runner, calls } = fakePowerShell(() => ({ elevated: true, error: '' }));
    expect(await windowsProcessElevated({ powershell: runner })).toBe(true);
    expect(calls[0]!.script).toContain(
      'IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    );
    expect(calls[0]!.script).toContain('EnableLUA');
    const { runner: unknown } = fakePowerShell(() => ({ ran: false }));
    expect(await windowsProcessElevated({ powershell: unknown })).toBe(false);
    const blocked: PowerShellRunner = async () => ({ code: 1, stdout: '', stderr: 'blocked' });
    expect(await windowsProcessElevated({ powershell: blocked })).toBe(false);
  });

  it('reports a refused registration with PowerShell’s reason', async () => {
    const { runner } = fakePowerShell(() => ({
      registered: false,
      disabled: false,
      ran: false,
      state: 'absent',
      error: 'Access is denied.',
    }));
    expect(await registerWindowsTask('t', '<Task/>', { powershell: runner })).toEqual({
      registered: false,
      disabled: false,
      error: 'Access is denied.',
    });
  });

  it('leaves a task its user disabled as it is', async () => {
    const { runner } = fakePowerShell(() => ({
      registered: true,
      disabled: true,
      ran: false,
      state: 'Disabled',
      error: '',
    }));
    expect(await registerWindowsTask('t', '<Task/>', { powershell: runner, start: true })).toEqual({
      registered: true,
      disabled: true,
    });
  });

  it('fails clearly when PowerShell cannot run or answers nothing usable', async () => {
    const blocked: PowerShellRunner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'This program is blocked by group policy.\r\nmore',
    });
    await expect(registerWindowsTask('t', '<Task/>', { powershell: blocked })).rejects.toThrow(
      'Windows PowerShell could not run (This program is blocked by group policy.)',
    );
    const { runner } = fakePowerShell(() => 'WARNING: not json');
    await expect(windowsTaskState('t', { powershell: runner })).rejects.toThrow(
      'Windows PowerShell could not run',
    );
  });

  it('starts, reads and removes a task by name, an absent one included', async () => {
    const { runner, calls } = fakePowerShell((env) =>
      'PUDDLE_TASK_WAIT_MS' in env
        ? { ran: false, state: 'Ready', lastResult: 267011, error: '' }
        : 'PUDDLE_TASK_NAME' in env && calls.length === 2
          ? { state: 'Running', lastResult: 267009, error: '' }
          : { removed: false, error: '' },
    );
    expect(await startWindowsTask('t', { powershell: runner })).toEqual({
      ran: false,
      state: 'ready',
      lastResult: 267011,
    });
    expect(await windowsTaskState('t', { powershell: runner })).toEqual({
      state: 'running',
      lastResult: 267009,
    });
    expect(await unregisterWindowsTask('t', { powershell: runner })).toBe(false);
    expect(calls.map((call) => call.env.PUDDLE_TASK_NAME)).toEqual(['t', 't', 't']);
    const { runner: failing } = fakePowerShell(() => ({ removed: false, error: 'denied' }));
    await expect(unregisterWindowsTask('t', { powershell: failing })).rejects.toThrow('denied');
  });

  it('creates a process through WMI with its command line in the environment', async () => {
    const { runner, calls } = fakePowerShell(() => ({ code: 0, pid: 4242, error: '' }));
    const command = '"C:\\a b\\bin\\puddle-hidden.exe" "C:\\a b\\bin\\node.exe" %NAME%';
    expect(await createWindowsProcess(command, 'C:\\Users\\a', { powershell: runner })).toBe(4242);
    expect(calls[0]!.env).toEqual({
      PUDDLE_PROCESS_COMMAND: command,
      PUDDLE_PROCESS_DIRECTORY: 'C:\\Users\\a',
    });
    expect(calls[0]!.script).toContain(
      'Invoke-CimMethod -ClassName Win32_Process -MethodName Create',
    );
    const { runner: refused } = fakePowerShell(() => ({ code: 2, pid: 0, error: '' }));
    await expect(createWindowsProcess(command, 'C:\\', { powershell: refused })).rejects.toThrow(
      'Win32_Process.Create returned 2',
    );
  });
});

/**
 * Real Windows PowerShell, but nothing persistent and no process: Task
 * Scheduler only validates the XML (TASK_VALIDATE_ONLY registers nothing),
 * and the WMI script is only parsed, never run.
 */
describe.runIf(process.platform === 'win32')('on this Windows machine', () => {
  it('runs Windows PowerShell without a profile and with the process execution policy bypassed', async () => {
    const result = await runWindowsPowerShell(
      "[Console]::Out.Write((Get-ExecutionPolicy -Scope Process).ToString() + '|' + $env:PUDDLE_PROBE)",
      { PUDDLE_PROBE: 'a & b; "c"' },
      60_000,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Bypass|a & b; "c"');
  }, 70_000);

  it('ships scripts that PowerShell parses, and reads an absent task without changing anything', async () => {
    const parse = await runWindowsPowerShell(
      [
        '$failures = @()',
        'foreach ($name in $env:PUDDLE_SCRIPTS -split ",") {',
        '  $errors = $null',
        '  $null = [Management.Automation.Language.Parser]::ParseInput((Get-Item "env:PUDDLE_SCRIPT_$name").Value, [ref]$null, [ref]$errors)',
        '  if ($errors) { $failures += "$name $($errors[0].Message)" }',
        '}',
        "[Console]::Out.Write('parsed:' + ($failures -join ';'))",
      ].join('\n'),
      {
        PUDDLE_SCRIPTS: Object.keys(WINDOWS_TASK_SCRIPTS).join(','),
        ...Object.fromEntries(
          Object.entries(WINDOWS_TASK_SCRIPTS).map(([name, script]) => [
            `PUDDLE_SCRIPT_${name}`,
            script,
          ]),
        ),
      },
      60_000,
    );
    expect(parse.stdout).toBe('parsed:');
    // A name no task has: every read-only path, and nothing to start or remove.
    const absent = `Puddle absent ${randomBytes(6).toString('hex')}`;
    expect(await windowsTaskState(absent)).toEqual({ state: 'absent', lastResult: null });
    expect(await startWindowsTask(absent)).toEqual({ ran: false, state: 'absent' });
    expect(await unregisterWindowsTask(absent)).toBe(false);
  }, 120_000);

  it('tells whether this process runs elevated, changing nothing', async () => {
    const result = await runWindowsPowerShell(WINDOWS_TASK_SCRIPTS.elevation, {}, 60_000);
    expect(JSON.parse(result.stdout.trim())).toEqual({ elevated: expect.any(Boolean), error: '' });
  }, 70_000);

  it('builds XML that Task Scheduler accepts, without registering it', async () => {
    const name = `Puddle validate ${randomBytes(6).toString('hex')}`;
    const home = 'C:\\Users\\Zoë Ørsted\\.puddle & co';
    const sid = (
      await runWindowsPowerShell(
        '[Console]::Out.Write(([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value)',
        {},
        60_000,
      )
    ).stdout.trim();
    const xml = windowsTaskXml(name, supervisorTaskDefinition(home, sid));
    const result = await runWindowsPowerShell(
      [
        "$ErrorActionPreference = 'Stop'",
        '$service = New-Object -ComObject Schedule.Service',
        '$service.Connect()',
        "$folder = $service.GetFolder('\\')",
        // 1: TASK_VALIDATE_ONLY; 3: TASK_LOGON_INTERACTIVE_TOKEN.
        '$null = $folder.RegisterTask($env:PUDDLE_TASK_NAME, $env:PUDDLE_TASK_XML, 1, $null, $null, 3, $null)',
        '$exists = $true',
        'try { $null = $folder.GetTask($env:PUDDLE_TASK_NAME) } catch { $exists = $false }',
        "[Console]::Out.Write('valid|' + $exists)",
      ].join('\n'),
      { PUDDLE_TASK_NAME: name, PUDDLE_TASK_XML: xml },
      60_000,
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('valid|False');
  }, 70_000);
});

/**
 * The register and start scripts run by real Windows PowerShell against a
 * stand-in Task Scheduler: PowerShell resolves a function before a cmdlet of
 * the same name, so every ScheduledTasks cmdlet the scripts call is a
 * function over PUDDLE_FAKE that only records what it was asked. Nothing
 * reaches Task Scheduler.
 */
const FAKE_SCHEDULER = [
  '$fake = $env:PUDDLE_FAKE | ConvertFrom-Json',
  '$script:calls = New-Object System.Collections.Generic.List[string]',
  '$script:started = $false',
  'function New-FakeTask($t) {',
  "  $state = if ($script:started -and $fake.runs -and $t.name -eq $env:PUDDLE_TASK_NAME) { 'Running' } else { $t.state }",
  "  [pscustomobject]@{ TaskName = $t.name; TaskPath = '\\'; State = $state; Principal = [pscustomobject]@{ UserId = $t.user }; Actions = @([pscustomobject]@{ Execute = $t.command; Arguments = $t.arguments }) }",
  '}',
  'function Get-ScheduledTask {',
  '  [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)',
  '  $found = @($fake.tasks | Where-Object { -not $TaskName -or $_.name -eq $TaskName } | ForEach-Object { New-FakeTask $_ })',
  '  if ($TaskName -and $found.Count -eq 0) { Write-Error "No task named $TaskName"; return }',
  '  $found',
  '}',
  'function Get-ScheduledTaskInfo {',
  '  [CmdletBinding()] param([Parameter(ValueFromPipeline = $true)]$InputObject, [string]$TaskName, [string]$TaskPath)',
  '  process {',
  "    if ($script:started) { [pscustomobject]@{ LastRunTime = [datetime]'2026-11-04T12:00:00'; LastTaskResult = [uint32]$fake.result } }",
  "    else { [pscustomobject]@{ LastRunTime = [datetime]'1999-11-30T00:00:00'; LastTaskResult = [uint32]267011 } }",
  '  }',
  '}',
  'function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath) $script:calls.Add("start $TaskName"); $script:started = $true }',
  'function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath, [string]$Xml, [switch]$Force) $script:calls.Add("register $TaskName") }',
  'function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath, [switch]$Confirm) $script:calls.Add("unregister $TaskName") }',
  'function Disable-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath) $script:calls.Add("disable $TaskName") }',
].join('\n');

interface FakeTask {
  name: string;
  state: 'Ready' | 'Running' | 'Disabled';
  user: string;
  command: string;
  arguments: string;
}

describe.runIf(process.platform === 'win32')(
  'the task scripts against a stand-in Task Scheduler',
  () => {
    const action = {
      PUDDLE_TASK_COMMAND: 'C:\\Users\\a b\\.puddle\\bin\\current\\bin\\puddle-hidden.exe',
      PUDDLE_TASK_ARGUMENTS:
        '"C:\\Users\\a b\\.puddle\\bin\\current\\bin\\node.exe" --home "C:\\Users\\a b\\.puddle"',
    };
    let me = '';
    const task = (overrides: Partial<FakeTask> = {}): FakeTask => ({
      name: 'Puddle 0123456789abcdef',
      state: 'Ready',
      // Task Scheduler reports its principal by account name.
      user: process.env.USERNAME ?? '',
      command: action.PUDDLE_TASK_COMMAND,
      arguments: action.PUDDLE_TASK_ARGUMENTS,
      ...overrides,
    });

    async function run(
      script: string,
      fake: { tasks: FakeTask[]; result?: number; runs?: boolean },
      env: Record<string, string> = {},
    ) {
      const result = await runWindowsPowerShell(
        [FAKE_SCHEDULER, script, "'calls:' + ($script:calls -join '|')"].join('\n'),
        {
          PUDDLE_FAKE: JSON.stringify({ result: 0, runs: false, ...fake }),
          PUDDLE_TASK_NAME: 'Puddle 0123456789abcdef',
          PUDDLE_TASK_WAIT_MS: '3000',
          PUDDLE_TASK_XML: '<Task/>',
          ...action,
          ...env,
        },
        60_000,
      );
      const lines = result.stdout.split(/\r?\n/);
      const report = lines.find((line) => line.startsWith('{'));
      const calls = lines.find((line) => line.startsWith('calls:'));
      if (report === undefined || calls === undefined) throw new Error(result.stderr);
      return {
        report: JSON.parse(report) as Record<string, unknown>,
        calls: calls.slice('calls:'.length).split('|').filter(Boolean),
      };
    }

    beforeAll(async () => {
      me = (
        await runWindowsPowerShell(
          '[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)',
          {},
          60_000,
        )
      ).stdout.trim();
    }, 70_000);

    it('starts a task of this user’s, and counts a run Task Scheduler refused as none', async () => {
      expect(me).toMatch(/^S-1-5-/);
      const ran = await run(WINDOWS_TASK_SCRIPTS.start, { tasks: [task()], runs: true });
      expect(ran.calls).toEqual(['start Puddle 0123456789abcdef']);
      expect(ran.report).toMatchObject({ ran: true, state: 'Running' });
      // Without a desktop session the run is refused, yet LastRunTime moves on.
      for (const refusal of [0x800710e0, 0x800704dd]) {
        const refused = await run(WINDOWS_TASK_SCRIPTS.start, {
          tasks: [task()],
          result: refusal,
        });
        expect(refused.calls).toEqual(['start Puddle 0123456789abcdef']);
        expect(refused.report).toMatchObject({ ran: false, state: 'Ready', lastResult: refusal });
      }
      // A run that launched and has already ended still ran.
      const ended = await run(WINDOWS_TASK_SCRIPTS.start, { tasks: [task()], result: 1 });
      expect(ended.report).toMatchObject({ ran: true, lastResult: 1 });
    }, 240_000);

    it('never starts or adopts a task of the name another account owns or that runs another programme', async () => {
      const foreign = await run(WINDOWS_TASK_SCRIPTS.start, {
        tasks: [task({ user: 'SYSTEM' })],
        runs: true,
      });
      expect(foreign.calls).toEqual([]);
      expect(foreign.report).toMatchObject({
        ran: false,
        error: expect.stringMatching(/another account/),
      });
      const other = await run(WINDOWS_TASK_SCRIPTS.start, {
        tasks: [task({ user: me, arguments: '"C:\\elsewhere\\x.exe"' })],
        runs: true,
      });
      expect(other.calls).toEqual([]);
      expect(other.report).toMatchObject({
        ran: false,
        error: expect.stringMatching(/another programme/),
      });

      // Registration neither replaces another account's task nor reports it, disabled or not.
      for (const state of ['Ready', 'Disabled'] as const) {
        const taken = await run(
          WINDOWS_TASK_SCRIPTS.register,
          { tasks: [task({ user: 'S-1-5-21-1-2-3-1001', state })] },
          { PUDDLE_TASK_START: '1' },
        );
        expect(taken.calls).toEqual([]);
        expect(taken.report).toMatchObject({
          registered: false,
          disabled: false,
          error: expect.stringMatching(/another account/),
        });
      }
      // This user's own disabled task stays as it is.
      const disabled = await run(
        WINDOWS_TASK_SCRIPTS.register,
        { tasks: [task({ state: 'Disabled' })] },
        { PUDDLE_TASK_START: '1' },
      );
      expect(disabled.calls).toEqual([]);
      expect(disabled.report).toMatchObject({ registered: true, disabled: true });
    }, 240_000);

    it('replaces this user’s earlier tasks for the home, keeping a disabled one’s choice', async () => {
      const swept = await run(
        WINDOWS_TASK_SCRIPTS.register,
        {
          tasks: [
            task({ name: 'Puddle 1111111111111111', state: 'Disabled' }),
            task({ name: 'Puddle 2222222222222222', user: 'SYSTEM' }),
            task({ name: 'Puddle 3333333333333333', arguments: '"C:\\other\\home"' }),
            task({ name: 'Puddle 4444444444444444', state: 'Running', user: me }),
            task({ name: 'Unrelated task' }),
          ],
        },
        { PUDDLE_TASK_START: '1' },
      );
      expect(swept.calls).toEqual([
        'register Puddle 0123456789abcdef',
        'disable Puddle 0123456789abcdef',
        'unregister Puddle 1111111111111111',
      ]);
      expect(swept.report).toMatchObject({ registered: true, disabled: true, replaced: 1 });
    }, 240_000);
  },
);
