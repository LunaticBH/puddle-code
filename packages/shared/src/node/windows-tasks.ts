import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { system32Path } from './environment.js';

/**
 * Per-user Task Scheduler tasks and process creation through Windows
 * PowerShell, the only automation layer Puddle uses on Windows
 * (docs/windows.md). Every script is a fixed string and every value travels
 * in an environment variable, so PowerShell never parses a path or an XML
 * document as code (the windows-acl.ts pattern). The runner is the seam
 * tests replace: no test registers a real task.
 */

export interface PowerShellResult {
  /** The exit status; null when PowerShell could not run or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a fixed script with `env` added to this process's environment. */
export type PowerShellRunner = (
  script: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<PowerShellResult>;

/** System32's Windows PowerShell, never one found on PATH. */
export const runWindowsPowerShell: PowerShellRunner = (script, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        env: { ...process.env, ...env },
        windowsHide: true,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          stdout,
          stderr,
        }),
    );
  });

export interface WindowsTaskOptions {
  powershell?: PowerShellRunner;
  timeoutMs?: number;
}

/** Task Scheduler's own states, plus `absent` for a task that is not registered. */
export type WindowsTaskState = 'absent' | 'ready' | 'running' | 'queued' | 'disabled' | 'unknown';

/** What a task runs and for whom: one program, started at the user's logon. */
export interface WindowsTaskDefinition {
  description: string;
  /** The user the task runs as and whose logon starts it. */
  userSid: string;
  /** An absolute program; Task Scheduler expands `%NAME%` in it and in the arguments. */
  command: string;
  /** Already quoted for the program's command line. */
  arguments: string;
  workingDirectory: string;
  /** 0 (realtime) to 10 (idle); Task Scheduler's default 7 runs below normal. */
  priority: number;
}

const xmlText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The task as Task Scheduler XML (schema 1.2, Windows 7 and later). It runs
 * only while its user is logged on (an interactive token, never stored
 * credentials, so DPAPI, Credential Manager and network shares work as in
 * the user's own session) without elevation, starts at that user's logon
 * and runs indefinitely on battery too. The defaults would stop it after
 * 72 hours, on battery and below normal priority. A run already in
 * progress is never doubled; Task Scheduler retries a failed launch.
 */
export function windowsTaskXml(name: string, task: WindowsTaskDefinition): string {
  if (!/^S-1-\d+(?:-\d+)+$/.test(task.userSid)) throw new Error('invalid user SID');
  if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 10) {
    throw new Error('invalid task priority');
  }
  return [
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlText(task.description)}</Description>`,
    `    <URI>\\${xmlText(name)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${task.userSid}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${task.userSid}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    `    <Priority>${task.priority}</Priority>`,
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlText(task.command)}</Command>`,
    `      <Arguments>${xmlText(task.arguments)}</Arguments>`,
    `      <WorkingDirectory>${xmlText(task.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/** Every script reports one compact JSON line; UTF-8 keeps localised messages intact. */
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
  '$name = $env:PUDDLE_TASK_NAME',
];

/**
 * Whose a task is and what it runs, before a script trusts one of its name.
 * Task Scheduler reports a principal by account name, so it is translated
 * to the SID it is compared with; one that cannot be translated is not this
 * user's. The action is this home's supervisor command line exactly
 * (PUDDLE_TASK_COMMAND and PUDDLE_TASK_ARGUMENTS), case aside.
 */
const OWNERSHIP = [
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  'function Test-OwnTask($task) {',
  '  $id = [string]$task.Principal.UserId',
  "  if ($id -notmatch '^S-1-\\d+(-\\d+)+$') {",
  '    try { $id = (New-Object Security.Principal.NTAccount($id)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return $false }',
  '  }',
  '  return $id -eq $me',
  '}',
  'function Test-TaskAction($task) {',
  '  $actions = @($task.Actions)',
  '  return $actions.Count -eq 1 -and [string]$actions[0].Execute -eq $env:PUDDLE_TASK_COMMAND -and [string]$actions[0].Arguments -eq $env:PUDDLE_TASK_ARGUMENTS',
  '}',
];

/**
 * Start the task, then wait (PUDDLE_TASK_WAIT_MS) until it runs or has run:
 * an interactive-token task does not run while its user has no desktop
 * session, and Start-ScheduledTask still succeeds then. Task Scheduler
 * stamps the run it refused with a new LastRunTime all the same, so a run
 * whose result is a refusal (0x800710E0 ERROR_REQUEST_REFUSED, 0x800704DD
 * ERROR_NOT_LOGGED_ON, compared as the unsigned values they are) never
 * counts as one. A run that is just ending (its program exited a moment
 * ago) is waited out first, since IgnoreNew would drop the start.
 */
const START = [
  'try {',
  '  $ending = (Get-Date).AddMilliseconds(5000)',
  "  while ([string](Get-ScheduledTask -TaskName $name -TaskPath '\\').State -eq 'Running' -and (Get-Date) -lt $ending) {",
  '    Start-Sleep -Milliseconds 200',
  '  }',
  "  $before = (Get-ScheduledTaskInfo -TaskName $name -TaskPath '\\').LastRunTime",
  "  Start-ScheduledTask -TaskName $name -TaskPath '\\'",
  '  $deadline = (Get-Date).AddMilliseconds([int]$env:PUDDLE_TASK_WAIT_MS)',
  '  do {',
  "    $task = Get-ScheduledTask -TaskName $name -TaskPath '\\'",
  '    $info = $task | Get-ScheduledTaskInfo',
  "    if ([string]$task.State -eq 'Running') { $out.ran = $true; break }",
  '    if ($info.LastRunTime -ne $before) {',
  '      $out.ran = @(2147946720, 2147943645) -notcontains [int64]$info.LastTaskResult',
  '      break',
  '    }',
  '    Start-Sleep -Milliseconds 200',
  '  } while ((Get-Date) -lt $deadline)',
  '  $out.state = [string]$task.State',
  '  $out.lastResult = [int64]$info.LastTaskResult',
  '} catch { $out.error = $_.Exception.Message }',
];

/**
 * Register (or replace) the task from PUDDLE_TASK_XML, and start it when
 * PUDDLE_TASK_START is 1. A task its user disabled stays as it is and is not
 * started: that is how a user turns logon autostart off. A task of that
 * name that another account registered is never replaced, nor reported as
 * registered. Once registered, this user's other root `Puddle *` tasks that
 * run the same command line (an earlier name of the home's task) are
 * removed, unless one is running, and one its user disabled leaves this one
 * disabled too.
 */
const REGISTER_SCRIPT = [
  ...PRELUDE,
  ...OWNERSHIP,
  "$out = @{ registered = $false; disabled = $false; ran = $false; state = 'absent'; error = ''; replaced = 0 }",
  "$existing = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue",
  'if ($existing -and -not (Test-OwnTask $existing)) {',
  "  $out.state = [string]$existing.State; $out.error = 'a scheduled task of this name runs as another account'",
  "} elseif ($existing -and [string]$existing.State -eq 'Disabled') {",
  "  $out.registered = $true; $out.disabled = $true; $out.state = 'Disabled'",
  '} else {',
  '  try {',
  "    $null = Register-ScheduledTask -TaskName $name -TaskPath '\\' -Xml $env:PUDDLE_TASK_XML -Force",
  "    $out.registered = $true; $out.state = 'Ready'",
  '  } catch { $out.error = $_.Exception.Message }',
  '}',
  'if ($out.registered -and $env:PUDDLE_TASK_COMMAND) {',
  '  try {',
  "    foreach ($other in @(Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue)) {",
  "      if ($other.TaskName -eq $name -or $other.TaskName -notlike 'Puddle *' -or [string]$other.State -eq 'Running') { continue }",
  '      if (-not (Test-OwnTask $other) -or -not (Test-TaskAction $other)) { continue }',
  "      if ([string]$other.State -eq 'Disabled' -and -not $out.disabled) {",
  "        $null = Disable-ScheduledTask -TaskName $name -TaskPath '\\'",
  "        $out.disabled = $true; $out.state = 'Disabled'",
  '      }',
  "      Unregister-ScheduledTask -TaskName $other.TaskName -TaskPath '\\' -Confirm:$false",
  '      $out.replaced = $out.replaced + 1',
  '    }',
  '  } catch {}',
  '}',
  "if ($out.registered -and -not $out.disabled -and $env:PUDDLE_TASK_START -eq '1') {",
  ...START.map((line) => `  ${line}`),
  '}',
  '$out | ConvertTo-Json -Compress',
].join('\n');

/**
 * Start the task only when this user registered it and, given
 * PUDDLE_TASK_COMMAND, it runs that command line: a task of the name that
 * runs anything else is reported, never started.
 */
const START_SCRIPT = [
  ...PRELUDE,
  ...OWNERSHIP,
  "$out = @{ ran = $false; state = 'absent'; error = '' }",
  "$existing = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue",
  'if ($existing -and -not (Test-OwnTask $existing)) {',
  "  $out.state = [string]$existing.State; $out.error = 'a scheduled task of this name runs as another account'",
  '} elseif ($existing -and $env:PUDDLE_TASK_COMMAND -and -not (Test-TaskAction $existing)) {',
  "  $out.state = [string]$existing.State; $out.error = 'the scheduled task of this name runs another programme'",
  "} elseif ($existing -and [string]$existing.State -eq 'Disabled') { $out.state = 'Disabled' } elseif ($existing) {",
  ...START.map((line) => `  ${line}`),
  '}',
  '$out | ConvertTo-Json -Compress',
].join('\n');

const STATE_SCRIPT = [
  ...PRELUDE,
  "$out = @{ state = 'absent'; lastResult = $null; error = '' }",
  'try {',
  "  $task = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue",
  '  if ($task) {',
  '    $out.state = [string]$task.State',
  '    $out.lastResult = [int64]($task | Get-ScheduledTaskInfo).LastTaskResult',
  '  }',
  '} catch { $out.error = $_.Exception.Message }',
  '$out | ConvertTo-Json -Compress',
].join('\n');

/** Absent is not an error: removal is idempotent. */
const UNREGISTER_SCRIPT = [
  ...PRELUDE,
  "$out = @{ removed = $false; error = '' }",
  'try {',
  "  $task = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue",
  '  if ($task) {',
  "    Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false",
  '    $out.removed = $true',
  '  }',
  '} catch { $out.error = $_.Exception.Message }',
  '$out | ConvertTo-Json -Compress',
].join('\n');

/**
 * Win32_Process.Create: the new process is WMI's child, outside the caller's
 * job object, so it outlives a launcher that a kill-on-close job ends (an
 * OpenSSH session, some CI and IDE hosts). It inherits no handles and
 * receives the user's own environment, not the caller's; its command line
 * reaches CreateProcess as given, `%NAME%` unexpanded.
 */
const CREATE_PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
  "$out = @{ code = -1; pid = 0; error = '' }",
  'try {',
  '  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
  '  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{',
  '    CommandLine = $env:PUDDLE_PROCESS_COMMAND',
  '    CurrentDirectory = $env:PUDDLE_PROCESS_DIRECTORY',
  '    ProcessStartupInformation = $startup',
  '  }',
  '  $out.code = [int]$created.ReturnValue',
  '  $out.pid = [int]$created.ProcessId',
  '} catch { $out.error = $_.Exception.Message }',
  '$out | ConvertTo-Json -Compress',
].join('\n');

/**
 * Whether this process runs elevated while its user's own logon token does
 * not: an administrator's elevated session under UAC (an OpenSSH session
 * of an administrator is one). The predicate is the one an SSH client's
 * probe uses (windows-remote.ts), refined by UAC: without it every process
 * of the account runs with the same token, the logon task's included.
 */
const ELEVATION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
  "$out = @{ elevated = $false; error = '' }",
  'try {',
  '  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
  '  $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  "  $lua = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name EnableLUA -ErrorAction SilentlyContinue).EnableLUA",
  '  $out.elevated = $admin -and $lua -ne 0',
  '} catch { $out.error = $_.Exception.Message }',
  '$out | ConvertTo-Json -Compress',
].join('\n');

/** Every fixed script, for tests that parse them with PowerShell's own parser. */
export const WINDOWS_TASK_SCRIPTS = {
  register: REGISTER_SCRIPT,
  start: START_SCRIPT,
  state: STATE_SCRIPT,
  unregister: UNREGISTER_SCRIPT,
  createProcess: CREATE_PROCESS_SCRIPT,
  elevation: ELEVATION_SCRIPT,
} as const;

const DEFAULT_TIMEOUT_MS = 60_000;

/** The script's JSON report, or an error naming what PowerShell said. */
async function run(
  script: string,
  env: Record<string, string>,
  opts: WindowsTaskOptions,
): Promise<Record<string, unknown>> {
  const result = await (opts.powershell ?? runWindowsPowerShell)(
    script,
    env,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const line = result.stdout
    .split(/\r?\n/)
    .map((each) => each.trim())
    .filter((each) => each.startsWith('{'))
    .pop();
  let report: unknown;
  try {
    report = line === undefined ? undefined : JSON.parse(line);
  } catch {
    report = undefined;
  }
  if (typeof report !== 'object' || report === null) {
    const reason = result.stderr.trim().split(/\r?\n/)[0] || `exit status ${String(result.code)}`;
    throw new Error(`Windows PowerShell could not run (${reason})`);
  }
  return report as Record<string, unknown>;
}

const reportedError = (report: Record<string, unknown>) =>
  typeof report.error === 'string' && report.error !== '' ? report.error : undefined;

function taskState(value: unknown): WindowsTaskState {
  const state = typeof value === 'string' ? value.toLowerCase() : '';
  return (
    (['absent', 'ready', 'running', 'queued', 'disabled'] as const).find(
      (known) => known === state,
    ) ?? 'unknown'
  );
}

export interface WindowsTaskStart {
  /** The task ran, or is running, after the start. */
  ran: boolean;
  state: WindowsTaskState;
  /** Task Scheduler's last result code, when it has one. */
  lastResult?: number;
  error?: string;
}

export interface WindowsTaskRegistration extends Partial<WindowsTaskStart> {
  /** The task exists now (`disabled` ones are left as their user set them). */
  registered: boolean;
  disabled: boolean;
  error?: string;
}

/** The one program a task runs, as its definition gives it. */
export type WindowsTaskAction = Pick<WindowsTaskDefinition, 'command' | 'arguments'>;

/** The action a script checks a task of the name against, in its environment. */
const actionEnv = (action: WindowsTaskAction | undefined): Record<string, string> =>
  action === undefined
    ? {}
    : { PUDDLE_TASK_COMMAND: action.command, PUDDLE_TASK_ARGUMENTS: action.arguments };

/**
 * Register `name` from `xml`, replacing an earlier definition of this user's
 * (never another account's); optionally start it. Given the `action` the XML
 * defines, this user's other `Puddle *` tasks that run it are removed.
 */
export async function registerWindowsTask(
  name: string,
  xml: string,
  opts: WindowsTaskOptions & {
    start?: boolean;
    startWaitMs?: number;
    action?: WindowsTaskAction;
  } = {},
): Promise<WindowsTaskRegistration> {
  const report = await run(
    REGISTER_SCRIPT,
    {
      PUDDLE_TASK_NAME: name,
      PUDDLE_TASK_XML: xml,
      PUDDLE_TASK_START: opts.start ? '1' : '0',
      PUDDLE_TASK_WAIT_MS: String(opts.startWaitMs ?? 5000),
      ...actionEnv(opts.action),
    },
    opts,
  );
  const error = reportedError(report);
  return {
    registered: report.registered === true,
    disabled: report.disabled === true,
    ...(opts.start && report.registered === true && report.disabled !== true
      ? { ran: report.ran === true, state: taskState(report.state) }
      : {}),
    ...(typeof report.lastResult === 'number' ? { lastResult: report.lastResult } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Start a registered task of this user's (running `action`, when given) and
 * report whether it ran; an absent task reports `absent`.
 */
export async function startWindowsTask(
  name: string,
  opts: WindowsTaskOptions & { startWaitMs?: number; action?: WindowsTaskAction } = {},
): Promise<WindowsTaskStart> {
  const report = await run(
    START_SCRIPT,
    {
      PUDDLE_TASK_NAME: name,
      PUDDLE_TASK_WAIT_MS: String(opts.startWaitMs ?? 5000),
      ...actionEnv(opts.action),
    },
    opts,
  );
  const error = reportedError(report);
  return {
    ran: report.ran === true,
    state: taskState(report.state),
    ...(typeof report.lastResult === 'number' ? { lastResult: report.lastResult } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export async function windowsTaskState(
  name: string,
  opts: WindowsTaskOptions = {},
): Promise<{ state: WindowsTaskState; lastResult: number | null }> {
  const report = await run(STATE_SCRIPT, { PUDDLE_TASK_NAME: name }, opts);
  const error = reportedError(report);
  if (error !== undefined) throw new Error(`Task Scheduler could not be read (${error})`);
  return {
    state: taskState(report.state),
    lastResult: typeof report.lastResult === 'number' ? report.lastResult : null,
  };
}

/** Remove the task; resolves whether one was registered. */
export async function unregisterWindowsTask(
  name: string,
  opts: WindowsTaskOptions = {},
): Promise<boolean> {
  const report = await run(UNREGISTER_SCRIPT, { PUDDLE_TASK_NAME: name }, opts);
  const error = reportedError(report);
  if (error !== undefined) throw new Error(`the scheduled task could not be removed (${error})`);
  return report.removed === true;
}

/**
 * Whether this process runs elevated under UAC (ELEVATION_SCRIPT). When
 * PowerShell cannot tell, it counts as not elevated: WMI, the only way that
 * asks, runs through PowerShell too.
 */
export async function windowsProcessElevated(opts: WindowsTaskOptions = {}): Promise<boolean> {
  try {
    const report = await run(ELEVATION_SCRIPT, { PUDDLE_QUERY: 'elevation' }, opts);
    return report.elevated === true;
  } catch {
    return false;
  }
}

/**
 * Create a process through WMI (see CREATE_PROCESS_SCRIPT); resolves with
 * its pid. `commandLine` is passed to CreateProcess unchanged, so its
 * program path must be absolute and quoted.
 */
export async function createWindowsProcess(
  commandLine: string,
  directory: string,
  opts: WindowsTaskOptions = {},
): Promise<number> {
  const report = await run(
    CREATE_PROCESS_SCRIPT,
    { PUDDLE_PROCESS_COMMAND: commandLine, PUDDLE_PROCESS_DIRECTORY: directory },
    opts,
  );
  const error = reportedError(report);
  if (report.code !== 0 || typeof report.pid !== 'number' || report.pid <= 0) {
    throw new Error(
      `WMI could not create the process (${error ?? `Win32_Process.Create returned ${String(report.code)}`})`,
    );
  }
  return report.pid;
}
