import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createWindowsProcess,
  registerWindowsTask,
  runWindowsPowerShell,
  startWindowsTask,
  unregisterWindowsTask,
  WINDOWS_TASK_SCRIPTS,
  windowsTaskState,
  windowsTaskXml,
  type PowerShellRunner,
  type WindowsTaskDefinition,
} from '../src/node/windows-tasks.js';
import {
  supervisorCommandLine,
  supervisorTaskDefinition,
  supervisorTaskName,
  unsupervisableHome,
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
  command: '%SystemRoot%\\System32\\conhost.exe',
  arguments: '--headless "C:\\Users\\a b\\x.exe" --home "C:\\Users\\a b"',
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
    expect(xml).toContain('<Command>%SystemRoot%\\System32\\conhost.exe</Command>');
    expect(xml).toContain(
      '<Arguments>--headless &quot;C:\\Users\\a b\\x.exe&quot; --home &quot;C:\\Users\\a b&quot;</Arguments>',
    );
    expect(xml).not.toMatch(/<\?xml/);
  });

  it('refuses a malformed SID or priority rather than writing it into the XML', () => {
    expect(() => windowsTaskXml('t', definition({ userSid: 'S-1-5</UserId>' }))).toThrow('SID');
    expect(() => windowsTaskXml('t', definition({ priority: 11 }))).toThrow('priority');
  });

  it('names one task per home, whichever spelling names it', () => {
    const name = supervisorTaskName('C:\\Users\\Ann\\.puddle');
    expect(name).toMatch(/^Puddle [0-9a-f]{16}$/);
    expect(supervisorTaskName('c:\\users\\ann\\.puddle')).toBe(name);
    expect(supervisorTaskName('C:\\Users\\Bob\\.puddle')).not.toBe(name);
  });

  it('starts the supervisor windowless through the current junction, quoting every path', () => {
    const home = 'C:\\Users\\Zoë Ørsted\\.puddle dev';
    const task = supervisorTaskDefinition(home, SID);
    expect(task.command).toBe('%SystemRoot%\\System32\\conhost.exe');
    expect(task.arguments).toBe(
      '--headless "C:\\Users\\Zoë Ørsted\\.puddle dev\\bin\\current\\bin\\node.exe" ' +
        '"C:\\Users\\Zoë Ørsted\\.puddle dev\\bin\\current\\daemon\\supervisor.mjs" ' +
        '--home "C:\\Users\\Zoë Ørsted\\.puddle dev"',
    );
    expect(task.priority).toBe(4);
    expect(task.description).toContain(home);
    // A drive-root home keeps its closing quote: the trailing backslash is doubled.
    expect(supervisorTaskDefinition('D:\\', SID).arguments).toMatch(/--home "D:\\\\"$/);
    expect(supervisorCommandLine(home)).toMatch(/^"[^"]+\\System32\\conhost\.exe" --headless "/);
  });

  it('refuses homes that Task Scheduler or conhost would expand or split', () => {
    expect(unsupervisableHome('C:\\Users\\a\\.puddle')).toBeUndefined();
    expect(unsupervisableHome('C:\\100%\\.puddle')).toMatch(/cannot be supervised/);
    expect(unsupervisableHome('C:\\a"b')).toMatch(/cannot be supervised/);
    expect(unsupervisableHome('C:\\a\tb')).toMatch(/cannot be supervised/);
    expect(unsupervisableHome('C:\\a\u007fb')).toMatch(/cannot be supervised/);
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
    const xml = windowsTaskXml(name, definition());
    expect(await registerWindowsTask(name, xml, { powershell: runner, start: true })).toEqual({
      registered: true,
      disabled: false,
      ran: true,
      state: 'running',
    });
    const [call] = calls;
    expect(call!.env).toMatchObject({
      PUDDLE_TASK_NAME: name,
      PUDDLE_TASK_XML: xml,
      PUDDLE_TASK_START: '1',
    });
    expect(call!.script).not.toContain(name);
    expect(call!.script).not.toContain('conhost');
    expect(call!.script).toContain('Register-ScheduledTask -TaskName $name');
    expect(call!.script).toContain('-Xml $env:PUDDLE_TASK_XML -Force');
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
    const command = '"C:\\Windows\\System32\\conhost.exe" --headless "C:\\a b\\node.exe"';
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
