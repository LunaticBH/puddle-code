# Standalone CLI installer for Windows, published as install.ps1 beside install.sh.
# Daemon installation stays inside the CLI. Release builds bake @@REPO@@;
# source runs accept -Repo or PUDDLE_REPO.
# Keep old releases: running cockpits still serve assets from their own tree.
#
#   irm https://github.com/<owner>/<repo>/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm <same URL>))) -Version 1.2.3
#
# Windows PowerShell 5.1 compatible. Keep this file ASCII: 5.1 reads a script
# without a byte order mark in the ANSI code page.
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$Repo = '',
  [string]$Prefix = '',
  [string]$BinDir = '',
  [Alias('Tarball')][string]$Archive = '',
  [string]$Sums = '',
  [switch]$NoPathUpdate,
  [switch]$Help
)

$PuddleUsage = @'
usage: install.ps1 [-Version X.Y.Z] [-Repo owner/repo]
                   [-Prefix <directory>] [-BinDir <directory>]
                   [-Archive <path>] [-Sums <path>] [-NoPathUpdate]

Installs the CLI with its own Node runtime; no npm or administrator rights required.
  -Version       release to install (default: latest); also accepts vX.Y.Z
  -Prefix        installation root (default: %LOCALAPPDATA%\puddle\cli,
                 respecting PUDDLE_CLI_HOME)
  -BinDir        launcher directory (default: %LOCALAPPDATA%\puddle\bin)
  -Archive       local archive for offline/development installation
  -Sums          SHA256SUMS for a local archive (otherwise warns and skips)
  -Repo          GitHub release repository (or PUDDLE_REPO)
  -NoPathUpdate  do not add the launcher directory to the user PATH
'@

# Runs under the staged bin\node.exe so every launcher, junction and record is
# written by Node (PowerShell 5.1 would add a byte order mark). The launcher
# bytes must match standaloneLauncher() in packages/cli (installation/standalone-cli.ts).
$PuddleActivation = @'
const fs = require('node:fs'), path = require('node:path');
const stat = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const owns = (p, text) => stat(p)?.isFile() === true && fs.readFileSync(p, 'utf8') === text;
// cmd.exe reads batch files in the OEM code page: refer to the root through
// %~dp0 (resolved by cmd itself) whenever a plain relative path reaches it.
const batchSafe = (text) => /^[\x20-\x7e]*$/.test(text) && !/[%"]/.test(text);
function activate(root, binDir, stage, pathArg) {
  const relative = path.relative(binDir, root);
  const base = !path.isAbsolute(relative) && batchSafe(relative)
    ? '%~dp0' + (relative === '' ? '' : relative + '\\')
    : root + '\\';
  if (!base.startsWith('%~dp0') && !batchSafe(base)) {
    throw Error('Choose -Prefix and -BinDir on one drive, or paths without non-ASCII characters or %');
  }
  // `(goto)` leaves the batch context once the line is read: cmd.exe never
  // rereads this file, so an upgrade or removal can replace or delete it while
  // it runs, and Ctrl+C cannot prompt to terminate a batch job.
  const wrapperFor = (script) =>
    '@rem puddle standalone launcher\r\n@(goto) 2>nul & "' + base + 'current\\bin\\node.exe" "' + base + 'current\\cli\\' + script + '" %*\r\n';
  const launcher = path.join(binDir, 'puddle.cmd');
  const wrapper = wrapperFor('index.js');
  const scriptLauncher = path.join(binDir, 'pudl.cmd');
  const scriptWrapper = wrapperFor('pudl.js');
  const hasScript = fs.existsSync(path.join(stage, 'pudl.cmd'));
  if (stat(launcher) && !owns(launcher, wrapper)) {
    throw Error('Refusing to replace an unrelated launcher: ' + launcher + '; choose -BinDir');
  }
  const ownsScript = owns(scriptLauncher, scriptWrapper);
  if (hasScript && stat(scriptLauncher) && !ownsScript) {
    throw Error('Refusing to replace an unrelated launcher: ' + scriptLauncher + '; choose -BinDir');
  }
  const current = path.join(root, 'current');
  if (stat(current) && !stat(current).isSymbolicLink()) throw Error('current must be a junction');
  const record = path.join(root, 'installation.json');
  let previous = null;
  if (stat(record)) {
    previous = JSON.parse(fs.readFileSync(record, 'utf8'));
    if (previous.launcher !== launcher) throw Error('Reuse the original -BinDir: ' + path.dirname(previous.launcher));
  }
  // Removal takes the PATH entry back out only when this installer added it.
  const pathEntry = pathArg === 'added' || previous?.pathEntry === true;
  const tmp = '.new-' + process.pid;
  try {
    const entry = { kind: 'puddle-cli', launcher, ...(hasScript ? { scriptLauncher } : {}), ...(pathEntry ? { pathEntry: true } : {}) };
    fs.writeFileSync(record + tmp, JSON.stringify(entry) + '\n', { flag: 'wx' });
    if (!owns(launcher, wrapper)) fs.writeFileSync(launcher + tmp, wrapper, { flag: 'wx' });
    if (hasScript && !ownsScript) fs.writeFileSync(scriptLauncher + tmp, scriptWrapper, { flag: 'wx' });
    // A junction needs no privilege. Nothing can be renamed over one, so the
    // old junction goes just before activation, under the installer lock.
    fs.symlinkSync(stage, current + tmp, 'junction');
    fs.renameSync(record + tmp, record);
    if (stat(launcher + tmp)) fs.renameSync(launcher + tmp, launcher);
    if (stat(scriptLauncher + tmp)) fs.renameSync(scriptLauncher + tmp, scriptLauncher);
    if (stat(current)) fs.unlinkSync(current);
    fs.renameSync(current + tmp, current); // Activate only after every other write succeeds.
    // Remove only this installation's own pudl launcher when a release lacks one.
    if (!hasScript && ownsScript) fs.unlinkSync(scriptLauncher);
  } finally {
    for (const file of [record + tmp, launcher + tmp, scriptLauncher + tmp, current + tmp]) fs.rmSync(file, { force: true });
  }
}
try {
  const [root, binDir, stage, pathArg] = process.argv.slice(2);
  activate(fs.realpathSync(root), fs.realpathSync(binDir), fs.realpathSync(stage), pathArg);
} catch (e) {
  console.error('puddle install: error: ' + e.message);
  process.exitCode = 1;
}
'@

function Install-PuddleCli {
  param(
    [string]$Version = '',
    [string]$Repo = '',
    [string]$Prefix = '',
    [string]$BinDir = '',
    [string]$Archive = '',
    [string]$Sums = '',
    [switch]$NoPathUpdate,
    [switch]$Help
  )
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest's progress bar slows 5.1 downloads by an order of magnitude.
  $ProgressPreference = 'SilentlyContinue'
  if ($Help) {
    Write-Output $PuddleUsage
    return
  }
  if (-not $Repo) { $Repo = if ($env:PUDDLE_REPO) { $env:PUDDLE_REPO } else { '@@REPO@@' } }
  $Version = $Version -replace '^v', ''
  $Arch = Get-PuddleArchitecture
  if (-not $env:LOCALAPPDATA) { Stop-Puddle 'LOCALAPPDATA is not set' }
  if (-not $Prefix) {
    $Prefix = if ($env:PUDDLE_CLI_HOME) { $env:PUDDLE_CLI_HOME } else { Join-Path $env:LOCALAPPDATA 'puddle\cli' }
  }
  if (-not $BinDir) { $BinDir = Join-Path $env:LOCALAPPDATA 'puddle\bin' }
  if (-not (Test-PuddleAbsolute $Prefix)) { Stop-Puddle '-Prefix must be an absolute path' }
  if (-not (Test-PuddleAbsolute $BinDir)) { Stop-Puddle '-BinDir must be an absolute path' }
  $Prefix = Get-PuddleFullPath $Prefix
  $BinDir = Get-PuddleFullPath $BinDir
  if (Test-PuddleReparsePoint $Prefix) { Stop-Puddle 'installation root must not be a symlink or junction' }
  [void][IO.Directory]::CreateDirectory($Prefix)
  if (-not (Test-PuddlePrivateRoot $Prefix)) {
    Stop-Puddle 'installation root must be owned by you and not writable by others'
  }
  $marker = [IO.Path]::Combine($Prefix, 'INSTALLATION')
  if (Test-Path -LiteralPath $marker) {
    if ((Test-PuddleReparsePoint $marker) -or (Read-PuddleText $marker) -ne 'puddle-cli') {
      Stop-Puddle 'unrecognised installation root'
    }
  } else {
    if (@(Get-ChildItem -LiteralPath $Prefix -Force).Count -ne 0) {
      Stop-Puddle 'refusing a non-empty unmanaged installation root'
    }
    [IO.File]::WriteAllText($marker, "puddle-cli`n")
  }
  $lock = [IO.Path]::Combine($Prefix, '.install-lock')
  try {
    New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
  } catch {
    Stop-Puddle "another installer is running (if interrupted, remove $lock and retry)"
  }
  $work = $null
  $stage = $null
  try {
    $versions = [IO.Path]::Combine($Prefix, 'versions')
    if (Test-PuddleReparsePoint $versions) { Stop-Puddle 'versions must not be a symlink or junction' }
    [void][IO.Directory]::CreateDirectory($versions)
    [void][IO.Directory]::CreateDirectory($BinDir)
    $work = [IO.Path]::Combine($Prefix, '.download.' + [IO.Path]::GetRandomFileName())
    [void][IO.Directory]::CreateDirectory($work)

    if ($Archive) {
      if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { Stop-Puddle "archive not found: $Archive" }
      $Archive = (Resolve-Path -LiteralPath $Archive).ProviderPath
      if ([IO.Path]::GetFileName($Archive) -match '^puddle-cli-v(.*)-win32-(x64|arm64)\.zip$') {
        if ($Matches[2] -ne $Arch) {
          Stop-Puddle "this archive is the win32-$($Matches[2]) build; this machine needs win32-$Arch"
        }
        if (-not $Version) { $Version = $Matches[1] }
      }
    } else {
      if (-not $Repo -or $Repo.Contains('@@')) { Stop-Puddle 'no repository baked in; pass -Repo owner/repo' }
      # Tests and mirrors may serve GitHub's release paths from another origin.
      $origin = if ($env:PUDDLE_RELEASE_ORIGIN) { $env:PUDDLE_RELEASE_ORIGIN.TrimEnd('/') } else { 'https://github.com' }
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      if (-not $Version) { $Version = Get-PuddleLatestVersion "$origin/$Repo/releases/latest" }
    }
    # Version strings become paths; accept release semver, including prereleases.
    if ($Version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$') {
      Stop-Puddle "invalid release version: $Version"
    }
    $file = "puddle-cli-v$Version-win32-$Arch.zip"
    if (-not $Archive) {
      $base = "$origin/$Repo/releases/download/v$Version"
      $Archive = [IO.Path]::Combine($work, $file)
      $Sums = [IO.Path]::Combine($work, 'SHA256SUMS')
      Write-PuddleStatus "fetching $base/$file"
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $Archive
      } catch {
        Stop-Puddle 'download failed (this platform/version may not be published)'
      }
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $Sums
      } catch {
        Stop-Puddle 'checksums download failed'
      }
    }
    if ($Sums) {
      if (-not (Test-Path -LiteralPath $Sums -PathType Leaf)) { Stop-Puddle "checksums file not found: $Sums" }
      $name = [IO.Path]::GetFileName($Archive)
      $expected = @(Get-Content -LiteralPath $Sums | ForEach-Object {
          $fields = -split $_
          if ($fields.Count -ge 2 -and $fields[1] -ceq $name) { $fields[0] }
        })
      if ($expected.Count -ne 1 -or $expected[0] -notmatch '^[0-9A-Fa-f]{64}$') {
        Stop-Puddle 'missing or ambiguous checksum'
      }
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash -ne $expected[0]) {
        Stop-Puddle 'checksum mismatch'
      }
    } else {
      Write-PuddleStatus 'warning: -Archive without -Sums - checksum verification skipped'
    }
    $stageName = "$Version." + [IO.Path]::GetRandomFileName().Replace('.', '')
    $stage = [IO.Path]::Combine($versions, $stageName)
    [void][IO.Directory]::CreateDirectory($stage)
    # tar.exe reads its arguments in the ANSI code page, which may not hold the
    # profile's name: it runs in the root, which reaches it intact as the
    # working directory, and receives ASCII paths relative to it.
    $workName = [IO.Path]::GetFileName($work)
    $source = [IO.Path]::GetFileName($Archive)
    if (-not (Test-PuddleSamePath ([IO.Path]::GetDirectoryName($Archive)) $work) -or $source -notmatch '^[\x20-\x7e]+$') {
      $source = 'archive.zip'
      Copy-Item -LiteralPath $Archive -Destination ([IO.Path]::Combine($work, $source))
    }
    $tar = [IO.Path]::Combine($env:SystemRoot, 'System32\tar.exe')
    Push-Location -LiteralPath $Prefix
    try {
      $extracted = Invoke-PuddleNative $tar @('-xf', "$workName\$source", '--strip-components=1', '-C', "versions\$stageName")
    } finally {
      Pop-Location
    }
    if ($extracted -ne 0) { Stop-Puddle 'extraction failed' }
    $standalone = [IO.Path]::Combine($stage, 'STANDALONE')
    $stagedVersion = [IO.Path]::Combine($stage, 'VERSION')
    if (-not (Test-Path -LiteralPath $standalone -PathType Leaf) -or
      -not (Test-Path -LiteralPath $stagedVersion -PathType Leaf) -or
      (Read-PuddleText $standalone) -ne 'puddle-cli' -or (Read-PuddleText $stagedVersion) -ne $Version) {
      Stop-Puddle 'archive metadata mismatch'
    }
    foreach ($asset in @('cli\index.js', 'cli\host-control.mjs', 'cli\public\index.html', 'cli\install.sh',
        'cli\install-cli.sh', 'cli\install-cli.ps1', 'bin\node.exe', 'puddle.cmd')) {
      if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($stage, $asset)) -PathType Leaf)) {
        Stop-Puddle "archive is missing $asset"
      }
    }
    # A renamed archive must not install another architecture's runtime.
    $node = [IO.Path]::Combine($stage, 'bin\node.exe')
    $runtime = Get-PuddlePeArchitecture $node
    if ($runtime -ne $Arch) {
      Stop-Puddle "archive is not the win32-$Arch build (its node.exe is $runtime)"
    }
    # Help loads the bundle without touching a daemon or user state.
    if ((Invoke-PuddleNative $node @([IO.Path]::Combine($stage, 'cli\index.js'), '--help')) -ne 0) {
      Stop-Puddle 'CLI smoke test failed'
    }
    if (Test-Path -LiteralPath ([IO.Path]::Combine($stage, 'pudl.cmd'))) {
      if ((Invoke-PuddleNative $node @([IO.Path]::Combine($stage, 'cli\pudl.js'), '--help')) -ne 0) {
        Stop-Puddle 'pudl smoke test failed'
      }
    }
    $addPath = -not $NoPathUpdate -and -not (Test-PuddleUserPath $BinDir)
    $activate = [IO.Path]::Combine($work, 'activate.cjs')
    [IO.File]::WriteAllText($activate, $PuddleActivation)
    $pathArgument = if ($addPath) { 'added' } else { 'unchanged' }
    if ((Invoke-PuddleNative $node @($activate, $Prefix, $BinDir, $stage, $pathArgument) -ShowOutput) -ne 0) {
      Stop-Puddle 'activation failed'
    }
    $stage = $null # Published releases stay intact, including those serving live cockpits.
    $launcher = [IO.Path]::Combine($BinDir, 'puddle.cmd')
    Write-PuddleStatus "installed CLI $Version at $launcher"
    if ($addPath) {
      Add-PuddleUserPath $BinDir
      Write-PuddleStatus "added $BinDir to your user PATH (new terminals pick it up)"
    } elseif (-not (Test-PuddleUserPath $BinDir) -and -not (Test-PuddleSessionPath $BinDir)) {
      Write-PuddleStatus "add $BinDir to PATH (for example in System Properties > Environment Variables)"
    }
    if (-not (Test-PuddleSessionPath $BinDir)) { $env:Path = "$env:Path;$BinDir" }
    $resolved = Get-Command puddle -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($resolved -and -not (Test-PuddleSamePath $resolved.Source $launcher)) {
      Write-PuddleStatus "warning: $($resolved.Source) precedes this installation on PATH; use $launcher or update PATH"
    }
  } finally {
    if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    if ($stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Write-PuddleStatus([string]$Message) { Write-Host "puddle install: $Message" }

function Stop-Puddle([string]$Message) { throw $Message }

# The operating system's architecture, never this (possibly emulated) process's.
# The machine-wide registry value is not redirected for x64 emulation on Arm
# or for 32-bit processes; .NET's OSArchitecture tells the truth only from
# .NET 7 (Windows PowerShell 5.1 runs on .NET Framework, where an emulated
# process sees X64); the environment describes this process alone.
function Get-PuddleArchitecture {
  $os = $null
  try {
    $os = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE
  } catch { $os = $null }
  if (-not $os) {
    try { $os = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { $os = $null }
  }
  if (-not $os) {
    $os = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }
  switch -regex ($os) {
    '^(X64|AMD64)$' { return 'x64' }
    '^ARM64$' { return 'arm64' }
    default { Stop-Puddle "unsupported architecture $os" }
  }
}

# The COFF machine of a PE file, read through e_lfanew: x64, arm64, or the
# machine number in hexadecimal for anything else.
function Get-PuddlePeArchitecture([string]$Path) {
  $stream = $null
  try {
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader $stream
    if ($reader.ReadUInt16() -ne 0x5A4D) { return 'not a PE image' }
    [void]$stream.Seek(0x3C, [IO.SeekOrigin]::Begin)
    [void]$stream.Seek($reader.ReadInt32(), [IO.SeekOrigin]::Begin)
    if ($reader.ReadUInt32() -ne 0x4550) { return 'not a PE image' }
    $machine = $reader.ReadUInt16()
  } catch {
    return 'unreadable'
  } finally {
    if ($stream) { $stream.Dispose() }
  }
  switch ($machine) {
    0x8664 { return 'x64' }
    0xAA64 { return 'arm64' }
    default { return ('machine 0x{0:X4}' -f $machine) }
  }
}

function Test-PuddleAbsolute([string]$Path) {
  return $Path -match '^[A-Za-z]:[\\/]' -or $Path -match '^\\\\[^\\]'
}

function Get-PuddleFullPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  while ($full.Length -gt 3 -and $full.EndsWith('\')) { $full = $full.Substring(0, $full.Length - 1) }
  return $full
}

function Test-PuddleReparsePoint([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return ($null -ne $item) -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Read-PuddleText([string]$Path) { return [IO.File]::ReadAllText($Path).TrimEnd("`r", "`n") }

# Owned by you (or by Administrators for an elevated administrator) and not
# writable by Everyone, Authenticated Users or Users: the ACL form of the sh
# installer's owner and mode check.
function Test-PuddlePrivateRoot([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = [Security.Principal.SecurityIdentifier]
  $owner = $acl.GetOwner($sid)
  $administrator = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($owner -ne $identity.User -and -not ($administrator -and $owner.Value -eq 'S-1-5-32-544')) { return $false }
  # Write, append, attribute, delete, ACL and ownership rights, plus generic write/all.
  $writes = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
  foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    if (@('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') -notcontains $rule.IdentityReference.Value) { continue }
    if (([int64]$rule.FileSystemRights -band $writes) -ne 0) { return $false }
  }
  return $true
}

function Get-PuddleLatestVersion([string]$Url) {
  $response = $null
  try {
    $request = [Net.WebRequest]::Create($Url)
    $request.Method = 'HEAD'
    $request.AllowAutoRedirect = $false
    $response = $request.GetResponse()
  } catch {
    $error0 = $_.Exception
    while ($error0 -and -not ($error0 -is [Net.WebException])) { $error0 = $error0.InnerException }
    if ($error0) { $response = $error0.Response }
  }
  if (-not $response) { Stop-Puddle 'cannot resolve latest release' }
  try { $location = [string]$response.Headers['Location'] } finally { $response.Close() }
  if ($location -notmatch '/tag/v?([^/?#]+)$') { Stop-Puddle 'cannot resolve latest release' }
  return $Matches[1]
}

# Native commands report through their exit code; their stderr stays visible.
function Invoke-PuddleNative([string]$File, [string[]]$Arguments, [switch]$ShowOutput) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($ShowOutput) { & $File @Arguments | Out-Host } else { & $File @Arguments | Out-Null }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $saved
  }
}

function Test-PuddleSamePath([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  try {
    return [IO.Path]::GetFullPath($Left).TrimEnd('\') -eq [IO.Path]::GetFullPath($Right).TrimEnd('\')
  } catch {
    return $false
  }
}

function Test-PuddleListed([string]$List, [string]$Directory) {
  foreach ($entry in @($List -split ';')) {
    if ($entry -and (Test-PuddleSamePath ([Environment]::ExpandEnvironmentVariables($entry)) $Directory)) { return $true }
  }
  return $false
}

function Get-PuddleUserPathValue {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if (-not $key) { return '' }
  try {
    return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {
    $key.Close()
  }
}

function Test-PuddleUserPath([string]$Directory) { return Test-PuddleListed (Get-PuddleUserPathValue) $Directory }

function Test-PuddleSessionPath([string]$Directory) { return Test-PuddleListed $env:Path $Directory }

# Edits HKCU\Environment directly: [Environment]::SetEnvironmentVariable would
# expand and flatten %VARIABLE% references in the existing user PATH.
function Add-PuddleUserPath([string]$Directory) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($value) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $entries = @($value -split ';' | Where-Object { $_ }) + $Directory
    $key.SetValue('Path', ($entries -join ';'), $kind)
  } finally {
    $key.Close()
  }
  # Setting a user variable broadcasts WM_SETTINGCHANGE, so new terminals see the edit.
  [Environment]::SetEnvironmentVariable('PUDDLE_INSTALL_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('PUDDLE_INSTALL_REFRESH', $null, 'User')
}

try {
  Install-PuddleCli @PSBoundParameters
} catch {
  $message = "puddle install: error: $($_.Exception.Message)"
  # A script file reports through its exit code; `irm | iex` must not close the caller's session.
  if ($PSCommandPath) {
    [Console]::Error.WriteLine($message)
    exit 1
  }
  throw $message
}
