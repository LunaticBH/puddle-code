import { CliError } from '../types.js';

/**
 * The one command a Windows SSH host runs (docs/windows.md): PowerShell is
 * the only automation layer there, whatever the OpenSSH server's default
 * shell is. The command line is a fixed loader passed with -EncodedCommand,
 * which cmd.exe, PowerShell and a Git Bash default shell all hand to
 * powershell.exe unchanged (base64 holds no character any of them treats
 * specially, and it carries no `=` padding that MSYS could take for an
 * assignment), and which stays far below cmd.exe's 8191-character limit.
 *
 * The loader reads a length-framed UTF-8 script from its raw standard input
 * (`PUDDLE1 <bytes>\n<script>`) and runs it with the rest of that stream, so
 * a payload (a release archive, the host helper, JSON for a connector) can
 * follow the script on the same connection. Scripts never write pipeline
 * output, whose text conversion would corrupt binary data: they write raw
 * bytes, and programs they start inherit the connection's own handles.
 * PowerShell default shells report every failure as status 1, so the loader
 * ends its standard error with `puddle-exit:<status>`, and it reports a
 * caught error there as plain UTF-8 rather than PowerShell's CLIXML.
 */

const FRAME_MAGIC = 'PUDDLE1';
const TRAILER = /(?:^|\n)puddle-exit:(-?\d+)\n?$/;

const LOADER_SOURCE = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';$s=1",
  // ConstrainedLanguage (AppLocker, WDAC) refuses every stream call below.
  "try{if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){throw ('puddle-language-mode:'+$ExecutionContext.SessionState.LanguageMode)}",
  '$e=[Console]::OpenStandardError()',
  "$i=[Console]::OpenStandardInput();$h='';while($true){$b=$i.ReadByte();if($b -lt 0){throw 'the script frame ended early'};if($b -eq 10){break};$h+=[char]$b;if($h.Length -gt 24){throw 'not a script frame'}}",
  `if($h -notmatch '^${FRAME_MAGIC} (\\d{1,9})$'){throw 'not a script frame'};$n=[int]$Matches[1];$a=New-Object byte[] $n;$o=0`,
  "while($o -lt $n){$r=$i.Read($a,$o,$n-$o);if($r -le 0){throw 'the script frame ended early'};$o+=$r}",
  // Assigned, so stray pipeline output never reaches the data stream.
  '$global:PuddleExit=0;$null=& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($a))) $i;$s=[int]$global:PuddleExit',
  "}catch{$m=[Text.Encoding]::UTF8.GetBytes('puddle-host: '+$_.Exception.Message+[char]10);$e.Write($m,0,$m.Length);$s=1}",
  "$t=[Text.Encoding]::ASCII.GetBytes('puddle-exit:'+$s+[char]10);$e.Write($t,0,$t.Length);$e.Flush();exit $s",
].join('\n');

/** UTF-16LE base64 whose length is a multiple of three bytes, so it has no padding. */
function encodeLoader(source: string): string {
  let text = source;
  while ((text.length * 2) % 3 !== 0) text += ' ';
  return Buffer.from(text, 'utf16le').toString('base64');
}

const ENCODED_LOADER = encodeLoader(LOADER_SOURCE);

/** The remote command line for every Windows host operation. */
export function windowsRemoteCommand(): string {
  return (
    'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass ' +
    `-EncodedCommand ${ENCODED_LOADER}`
  );
}

/** The loader's source, for tests that run it directly. */
export const WINDOWS_LOADER = LOADER_SOURCE;

/** `PUDDLE1 <bytes>\n` and the script, as the loader reads them. */
export function frame(script: string): Buffer {
  const body = Buffer.from(script, 'utf8');
  return Buffer.concat([Buffer.from(`${FRAME_MAGIC} ${body.length}\n`, 'ascii'), body]);
}

/**
 * The script's own status from the loader's trailer, and standard error
 * without it. `code` is null when no trailer arrived: the loader never ran
 * to its end (no PowerShell, a dropped connection, a constrained session).
 */
export function parseTrailer(stderr: string): { code: number | null; stderr: string } {
  const match = TRAILER.exec(stderr);
  if (!match) return { code: null, stderr };
  return { code: Number(match[1]), stderr: stderr.slice(0, match.index) };
}

/** A PowerShell single-quoted literal: only `'` is special inside one. */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/** JSON in base64: an argument no shell or command-line parser can split or expand. */
export function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** The inverse of b64json, for the host helper. */
export function fromB64json(value: string | undefined): unknown {
  if (value === undefined || value === '') return {};
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

/**
 * A host that runs PowerShell in ConstrainedLanguage mode, which AppLocker
 * and WDAC policies impose: Puddle's host commands cannot run there.
 */
export function languageModeRefusal(host: string, output: string): CliError | null {
  if (!/puddle-language-mode:|language mode|core types/i.test(output)) return null;
  return new CliError(
    'unsupported_platform',
    `${host} runs PowerShell in ConstrainedLanguage mode, which blocks Puddle's host commands`,
    'an AppLocker or WDAC policy imposes it; run Puddle there under an account the policy allows full PowerShell',
  );
}

/**
 * Helpers every script starts with. `Get-PuddleHome` mirrors clientHome():
 * PUDDLE_HOME, else `%USERPROFILE%\.puddle` (never $HOME, which PowerShell
 * owns). `Invoke-PuddleNode` starts a program that inherits this process's
 * own standard input and output, so they reach it byte for byte; only its
 * standard error is relayed, ahead of the loader's trailer.
 */
const PRELUDE = String.raw`param($PuddleIn)
$PuddleOut = [Console]::OpenStandardOutput()
function Write-PuddleBytes([byte[]]$Bytes) { $PuddleOut.Write($Bytes, 0, $Bytes.Length); $PuddleOut.Flush() }
function Write-PuddleLine([string]$Text) { Write-PuddleBytes ([Text.Encoding]::UTF8.GetBytes($Text + [char]10)) }
function Write-PuddleLog([string]$Message) { Write-PuddleLine (ConvertTo-Json -Compress -InputObject @{ t = 'log'; level = 'info'; message = $Message }) }
function Get-PuddleHome { if ($env:PUDDLE_HOME) { $env:PUDDLE_HOME } else { Join-Path $env:USERPROFILE '.puddle' } }
function Get-PuddleTemp {
  $dir = Join-Path ([IO.Path]::GetTempPath()) 'puddle-host'
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if (-not (Test-Path -LiteralPath $dir)) {
    # Owner-only from the start, whatever its parent lets others do (TEMP=C:\Temp).
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetOwner($me)
    $sec.SetAccessRuleProtection($true, $false)
    $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
    [void][IO.Directory]::CreateDirectory($dir, $sec)
  }
  $item = Get-Item -LiteralPath $dir -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$dir is not a plain directory" }
  # As the home is checked: owned by this account (or SYSTEM or Administrators),
  # and granting nobody else anything, so nobody else can plant or swap what runs.
  $acl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access')
  $sid = [Security.Principal.SecurityIdentifier]
  $trusted = @($me.Value, 'S-1-5-18', 'S-1-5-32-544')
  if ($trusted -notcontains $acl.GetOwner($sid).Value) { throw "$dir belongs to another account" }
  $allowed = $trusted + @('S-1-3-0', 'S-1-3-4')
  foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value) {
      throw "$dir is open to other accounts: delete it, then connect again"
    }
  }
  $dir
}
function Test-PuddleHelper([string]$Path, [string]$Sha256) {
  [IO.File]::Exists($Path) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -eq $Sha256
}
function ConvertTo-PuddleArgument([string]$Value) {
  if ($Value.Contains('"')) { throw 'an argument holds a quotation mark' }
  '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}
function Invoke-PuddleNode([string]$Program, [string[]]$Arguments) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Program
  $psi.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-PuddleArgument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $env:USERPROFILE
  # Redirecting only standard error hands the child this process's own
  # standard input and output (STARTF_USESTDHANDLES).
  $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $err = [Console]::OpenStandardError()
  $pump = $p.StandardError.BaseStream.CopyToAsync($err)
  $p.WaitForExit()
  [void]$pump.Wait()
  $err.Flush()
  $p.ExitCode
}
function Invoke-PuddleQuiet([string]$Program, [string[]]$Arguments, [string]$Directory) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Program
  $psi.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-PuddleArgument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $Directory
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  $p.WaitForExit()
  @{ code = $p.ExitCode; output = ($out.Result + $err.Result).Trim() }
}
function Get-PuddlePeMachine([string]$Path) {
  if (-not [IO.File]::Exists($Path)) { return $null }
  $f = [IO.File]::OpenRead($Path)
  try {
    $b = New-Object byte[] 4096
    $n = $f.Read($b, 0, $b.Length)
    if ($n -lt 64 -or $b[0] -ne 0x4d -or $b[1] -ne 0x5a) { return 'other' }
    $o = [BitConverter]::ToInt32($b, 60)
    if ($o -lt 0 -or $o + 6 -gt $n -or $b[$o] -ne 0x50 -or $b[$o + 1] -ne 0x45) { return 'other' }
    switch ([BitConverter]::ToUInt16($b, $o + 4)) { 0x8664 { 'x64' } 0xAA64 { 'arm64' } 0x14c { 'x86' } default { 'other' } }
  } finally { $f.Dispose() }
}
function Get-PuddleArch {
  $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
  $value = (Get-ItemProperty -LiteralPath $key -Name PROCESSOR_ARCHITECTURE -ErrorAction SilentlyContinue).PROCESSOR_ARCHITECTURE
  if (-not $value) { $value = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
  switch ("$value".ToUpperInvariant()) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { "$value".ToLowerInvariant() } }
}
function Receive-PuddlePayload([string]$Path, [long]$Length) {
  $f = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try {
    $buffer = New-Object byte[] 65536
    $left = $Length
    while ($left -gt 0) {
      $read = $PuddleIn.Read($buffer, 0, [int][Math]::Min([long]$buffer.Length, $left))
      if ($read -le 0) { throw 'the connection ended before the whole file arrived' }
      $f.Write($buffer, 0, $read)
      $left -= $read
    }
  } finally { $f.Dispose() }
}
`;

/** Optional per-connection settings every script applies first. */
export interface WindowsScriptOptions {
  /**
   * A PUDDLE_HOME for the host side of this connection. Only tests set it
   * (an isolated home on a real host); hosts otherwise use their own
   * environment, as POSIX hosts do.
   */
  home?: string;
}

/** A complete script: the prelude, any home override, then the operation. */
export function windowsScript(body: string, opts: WindowsScriptOptions = {}): string {
  const home = opts.home === undefined ? '' : `$env:PUDDLE_HOME = ${psQuote(opts.home)}\n`;
  return `${PRELUDE}${home}${body}\n`;
}

/**
 * What a Windows host reports about itself: the probe that recognises one,
 * and the facts every later operation needs (the installed runtime, its
 * architecture against the machine's, elevation).
 */
export const PROBE_SCRIPT = String.raw`$h = Get-PuddleHome
$current = Join-Path $h 'bin\current'
$target = $null
$link = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
if ($link -and $link.Target) { $target = [string]@($link.Target)[0] }
$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
Write-PuddleLine (ConvertTo-Json -Compress -InputObject @{
  puddle = 'windows-host'
  home = [string]$h
  current = $target
  node = Get-PuddlePeMachine (Join-Path $current 'bin\node.exe')
  arch = Get-PuddleArch
  build = [int][Environment]::OSVersion.Version.Build
  elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  temp = [IO.Path]::GetTempPath()
})`;

export interface WindowsProbe {
  home: string;
  /** `bin\current`'s junction target, or null. */
  current: string | null;
  /** The PE machine of `bin\current\bin\node.exe`, or null when there is none. */
  node: string | null;
  /** The operating system's architecture (x64 or arm64). */
  arch: string;
  build: number;
  /** An administrator's SSH session, which Windows OpenSSH runs elevated. */
  elevated: boolean;
  temp: string;
}

/** The probe's answer, or null for anything a Windows host running the probe would not print. */
export function parseProbe(stdout: string): WindowsProbe | null {
  const line = stdout
    .split(/\r?\n/)
    .map((each) => each.trim())
    .find((each) => each.startsWith('{'));
  if (line === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const text = (key: string) => typeof v[key] === 'string' && v[key] !== '';
  const optional = (key: string) => v[key] === null || v[key] === undefined || text(key);
  if (
    v.puddle !== 'windows-host' ||
    !text('home') ||
    !text('arch') ||
    !text('temp') ||
    !optional('current') ||
    !optional('node') ||
    typeof v.build !== 'number' ||
    typeof v.elevated !== 'boolean'
  ) {
    return null;
  }
  return {
    home: v.home as string,
    current: (v.current as string | null | undefined) ?? null,
    node: (v.node as string | null | undefined) ?? null,
    arch: v.arch as string,
    build: v.build,
    elevated: v.elevated,
    temp: v.temp as string,
  };
}

/**
 * Names the POSIX host-path expressions (paths.ts) stand for, relative to
 * the home: a Windows host resolves its home itself, so readFile maps them.
 */
export const WINDOWS_HOME_FILES = [
  'token',
  'config.json',
  'runtime.json',
  'supervisor',
  'puddled.pid',
];

/** Status 2: no such file. */
export function readHomeFileScript(name: string): string {
  if (!WINDOWS_HOME_FILES.includes(name)) throw new Error(`not a home file: ${name}`);
  return String.raw`$path = Join-Path (Get-PuddleHome) ${psQuote(name)}
if (-not [IO.File]::Exists($path)) { $global:PuddleExit = 2; return }
Write-PuddleBytes ([IO.File]::ReadAllBytes($path))`;
}

/**
 * Stage the host helper as `%TEMP%\puddle-host\<name>` from the payload
 * that follows the script, and print its path. That folder is this
 * account's alone (Get-PuddleTemp creates it owner-only and refuses one
 * that is not: %TEMP% may be C:\Temp, which every user can write), and
 * the copy just received and checked always replaces whatever has the
 * name; one already there is kept only while another operation holds it
 * open, and only when it is identical.
 *
 * Staging runs once per client process, so it also clears what operations
 * ended midway by the SSH session's job left behind, their `finally` never
 * having run: copies of node.exe (about 80 MB each), bootstrap directories
 * and partial stages. They go by creation time (a copy keeps its source's
 * write time) once a day old, far longer than any operation takes; one
 * still in use is locked, and links are never followed.
 */
export function stageScript(name: string, sha256: string, length: number): string {
  if (!/^[\w.-]+$/.test(name) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('bad stage');
  return String.raw`$dir = Get-PuddleTemp
$stale = [DateTime]::UtcNow.AddDays(-1)
foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
  if (-not ($item.Name -like 'node-*.exe' -or $item.Name -like 'boot-*' -or $item.Name -like 'windows-host-*.mjs.*')) { continue }
  if ($item.CreationTimeUtc -lt $stale) { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
$dest = Join-Path $dir ${psQuote(name)}
$want = ${psQuote(sha256.toUpperCase())}
$tmp = $dest + '.' + [Guid]::NewGuid().ToString('N')
try {
  Receive-PuddlePayload $tmp ${length}
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash -ne $want) { throw 'the host helper arrived damaged' }
  try { Move-Item -LiteralPath $tmp -Destination $dest -Force }
  catch { if (-not (Test-PuddleHelper $dest $want)) { throw } }
} finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
Write-PuddleLine (ConvertTo-Json -Compress -InputObject @{ path = [string]$dest })`;
}

/** Which node.exe runs the helper. */
export type HelperRuntime =
  /** `bin\current\bin\node.exe`. */
  | 'current'
  /**
   * A temporary copy of it, deleted afterwards: a helper that installs or
   * removes a release must not hold that tree's node.exe image open.
   */
  | 'copy';

/**
 * Status 3: the staged helper has gone (Storage Sense clears %TEMP%), or is
 * no longer the bytes staged, so stage it again.
 */
export const HELPER_MISSING_EXIT = 3;

/** The staged helper: its path on the host and the SHA-256 it must still have when it runs. */
export interface StagedHelper {
  path: string;
  sha256: string;
}

/** Exit 3 unless the staged helper is still the bytes staged, checked just before it runs. */
function helperCheck(helper: StagedHelper): string {
  if (!/^[0-9a-f]{64}$/.test(helper.sha256)) throw new Error('bad helper digest');
  return String.raw`$helper = ${psQuote(helper.path)}
$null = Get-PuddleTemp
if (-not (Test-PuddleHelper $helper ${psQuote(helper.sha256.toUpperCase())})) { $global:PuddleExit = ${HELPER_MISSING_EXIT}; return }`;
}

/** Status 4: no runtime is installed, so no node.exe can run the helper. */
export const NO_RUNTIME_EXIT = 4;

/**
 * Run the staged helper's `op` with a base64 JSON request; its stdin and
 * stdout are the connection's. The staging folder's privacy and the
 * helper's digest are checked again first.
 */
export function runHelperScript(
  helper: StagedHelper,
  op: string,
  request: unknown,
  runtime: HelperRuntime,
): string {
  if (!/^[a-z-]+$/.test(op)) throw new Error(`bad helper op: ${op}`);
  return String.raw`${helperCheck(helper)}
$node = Join-Path (Get-PuddleHome) 'bin\current\bin\node.exe'
if (-not [IO.File]::Exists($node)) { $global:PuddleExit = ${NO_RUNTIME_EXIT}; return }
$copy = $null
if (${psQuote(runtime)} -eq 'copy') {
  $copy = Join-Path (Get-PuddleTemp) ('node-' + [Guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath $node -Destination $copy
  $node = $copy
}
try {
  $global:PuddleExit = Invoke-PuddleNode $node @($helper, ${psQuote(op)}, ${psQuote(b64json(request))})
} finally {
  if ($copy) { Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue }
}`;
}

export interface BootstrapRequest {
  version: string;
  /** The helper's install request, run by the archive's own node.exe. */
  install: unknown;
  /** The staged helper, checked again before anything is fetched. */
  helper: StagedHelper;
  /** `owner/repo` to download from; absent with a streamed archive. */
  slug?: string;
  /** A streamed archive: its release name, size and SHA-256, and whether that sum is authentic. */
  archive?: { name: string; length: number; sha256: string; verified: boolean };
}

/**
 * First installation, before any node.exe exists on the host (decision 3):
 * fetch this machine's release zip and SHA256SUMS with System32's curl.exe
 * (which honours the proxy variables), or receive the zip that follows the
 * script; verify it with Get-FileHash; unpack only `bin\node.exe` with
 * System32's tar.exe; then let the helper, run by that node.exe, install the
 * archive as `installWindowsDaemon` installs a local one. Everything happens
 * in the account's private staging folder (Get-PuddleTemp); the helper
 * copies the archive into the home it creates privately.
 */
export function bootstrapScript(request: BootstrapRequest): string {
  const { version, archive } = request;
  if (!/^[\w.+-]+$/.test(version)) throw new Error('bad version');
  if (archive && !/^[\x21-\x7e]+$/.test(archive.name)) throw new Error('bad archive name');
  if (request.slug !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(request.slug))
    throw new Error('bad slug');
  return String.raw`${helperCheck(request.helper)}
$work = Join-Path (Get-PuddleTemp) ('boot-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
try {
  $arch = Get-PuddleArch
  if ($arch -ne 'x64' -and $arch -ne 'arm64') { throw "Puddle has no Windows $arch build" }
  $system = Join-Path $env:SystemRoot 'System32'
  ${archive ? receiveArchive(archive) : downloadArchive(version, request.slug)}
  $tar = Join-Path $system 'tar.exe'
  if (-not [IO.File]::Exists($tar)) { throw 'tar.exe is missing (it ships with Windows 10 1803 and later)' }
  # Relative ASCII names: tar.exe reads its arguments in the ANSI code page.
  [void][IO.Directory]::CreateDirectory((Join-Path $work 'node'))
  $run = Invoke-PuddleQuiet $tar @('-xf', $name, '-C', 'node', '--strip-components', '2', ${psQuote(`puddled-v${version}/bin/node.exe`)}) $work
  $node = Join-Path $work 'node\node.exe'
  if ($run.code -ne 0 -or -not [IO.File]::Exists($node)) { throw "the archive has no bin\node.exe: $($run.output)" }
  $machine = Get-PuddlePeMachine $node
  if ($machine -ne $arch) { throw "$name is the win32-$machine build; this machine needs puddled-v${version}-win32-$arch.zip" }
  # The archive's path follows the request: the helper installs it as a local --tarball.
  $global:PuddleExit = Invoke-PuddleNode $node @($helper, 'install', ${psQuote(b64json(request.install))}, (Join-Path $work $name))
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}`;
}

function receiveArchive(archive: NonNullable<BootstrapRequest['archive']>): string {
  return String.raw`$name = ${psQuote(archive.name)}
  Write-PuddleLog "receiving $name"
  Receive-PuddlePayload (Join-Path $work $name) ${archive.length}
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work $name)).Hash -ne ${psQuote(archive.sha256.toUpperCase())}) { throw "$name arrived damaged" }
  ${archive.verified ? String.raw`[IO.File]::WriteAllText((Join-Path $work ($name + '.sha256')), ${psQuote(`${archive.sha256}  ${archive.name}\n`)})` : ''}`;
}

function downloadArchive(version: string, slug: string | undefined): string {
  if (slug === undefined) {
    return `throw 'no release source is configured for this build; pass --tarball <path> or set PUDDLE_REPO=owner/repo'`;
  }
  return String.raw`$name = "puddled-v${version}-win32-$arch.zip"
  $curl = Join-Path $system 'curl.exe'
  if (-not [IO.File]::Exists($curl)) { throw 'curl.exe is missing (it ships with Windows 10 1803 and later)' }
  $base = ${psQuote(`https://github.com/${slug}/releases/download/v${version}/`)}
  Write-PuddleLog "fetching $base$name"
  foreach ($file in @($name, 'SHA256SUMS')) {
    $run = Invoke-PuddleQuiet $curl @('-fsSL', '--retry', '3', '-o', $file, ($base + $file)) $work
    if ($run.code -ne 0) { throw "download failed: $($run.output)" }
  }
  $line = Get-Content -LiteralPath (Join-Path $work 'SHA256SUMS') | Where-Object { $_ -match ('^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($name) + '$') } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS does not list $name" }
  $want = ($line -split '\s+')[0].ToUpperInvariant()
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work $name)).Hash -ne $want) { throw 'checksum mismatch — deleted the download' }
  [IO.File]::WriteAllText((Join-Path $work ($name + '.sha256')), $line + [char]10)`;
}
