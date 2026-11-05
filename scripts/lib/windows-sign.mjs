// Optional Authenticode signing of the Windows release archives (docs/windows.md).
//
// PUDDLE_WINDOWS_SIGNING selects the mode; the release workflow sets it from
// the repository's secrets and variables:
//   certificate  WIN_CSC_LINK (a base64 PFX, or a path to one) and
//                WIN_CSC_KEY_PASSWORD, signed with the Windows SDK's signtool
//                (SIGNTOOL_PATH overrides the lookup)
//   azure        Azure Trusted Signing through Invoke-TrustedSigning, using
//                the Azure CLI login of azure/login (OIDC) and
//                AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT and
//                AZURE_SIGNING_PROFILE. Its AzureCliCredential cannot renew
//                the federated GitHub token, so the release workflow logs in
//                and caches the codesigning token just before each step that
//                signs.
//   none/unset   nothing is signed: the archive is exactly what an unsigned
//                build always was
//
// Every .exe, .dll and .node under the tree (and each .ps1 with `scripts`)
// whose signature Windows does not already report as Valid is signed, so
// files that carry their publisher's signature (node.exe, conpty.dll,
// OpenConsole.exe) stay byte-identical. Each newly signed file must then be
// Valid with a timestamp. The archive builders call this before their smoke
// tests and before packing, so the smoke test loads the signed binaries and
// SHA256SUMS covers the signed bytes.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Windows PowerShell 5.1 script; the root and the secrets arrive through the
 * environment, never a command line: signtool receives a re-encrypted copy
 * of the PFX and its one-time password. No backtick or dollar-brace may
 * appear in it: this is a JavaScript template literal.
 */
export const SIGN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Plain text on stderr: an -EncodedCommand error record would arrive as CLIXML.
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$root = $env:PUDDLE_SIGN_ROOT
$extensions = @('.exe', '.dll', '.node')
if ($env:PUDDLE_SIGN_SCRIPTS -eq '1') { $extensions += '.ps1' }
$candidates = @(Get-ChildItem -LiteralPath $root -Recurse -File |
  Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() } |
  Sort-Object FullName | ForEach-Object { $_.FullName })
$unsigned = @($candidates | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_).Status -ne 'Valid' })
Write-Output "$($unsigned.Count) of $($candidates.Count) files need a signature ($env:PUDDLE_WINDOWS_SIGNING)"
$batches = @()
for ($i = 0; $i -lt $unsigned.Count; $i += 32) {
  $batches += ,@($unsigned[$i..([Math]::Min($i + 31, $unsigned.Count - 1))])
}
if ($unsigned.Count -gt 0 -and $env:PUDDLE_WINDOWS_SIGNING -eq 'certificate') {
  $signtool = $env:SIGNTOOL_PATH
  if (-not $signtool) {
    $kits = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    $architectures = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { @('arm64', 'x64', 'x86') } else { @('x64', 'x86') }
    $versions = @(Get-ChildItem -LiteralPath $kits -Directory -Filter '10.*' -ErrorAction SilentlyContinue |
      Sort-Object { [version]$_.Name } -Descending)
    foreach ($architecture in $architectures) {
      $signtool = $versions | ForEach-Object { Join-Path $_.FullName "$architecture\signtool.exe" } |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
      if ($signtool) { break }
    }
    if (-not $signtool) { throw 'signtool.exe not found: install the Windows SDK or set SIGNTOOL_PATH' }
  }
  $pfx = Join-Path ([IO.Path]::GetTempPath()) ('puddle-sign-' + [Guid]::NewGuid().ToString('N') + '.pfx')
  [byte[]]$bytes = if ($env:WIN_CSC_LINK.Length -lt 1024 -and (Test-Path -LiteralPath $env:WIN_CSC_LINK -PathType Leaf)) {
    [IO.File]::ReadAllBytes($env:WIN_CSC_LINK)
  } else {
    [Convert]::FromBase64String($env:WIN_CSC_LINK)
  }
  $options = @('sign', '/fd', 'SHA256', '/td', 'SHA256', '/tr', $env:PUDDLE_TIMESTAMP_URL, '/f', $pfx)
  $certificates = New-Object Security.Cryptography.X509Certificates.X509Certificate2Collection
  try {
    if ($env:WIN_CSC_KEY_PASSWORD) {
      # The password never reaches a command line: Windows PowerShell 5.1
      # passes native arguments without escaping a quote or a trailing
      # backslash. .NET opens the PFX with it, and signtool receives a copy
      # under a one-time hexadecimal password, deleted with the copy.
      $certificates.Import($bytes, $env:WIN_CSC_KEY_PASSWORD, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
      $random = New-Object byte[] 24
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
      $password = [BitConverter]::ToString($random).Replace('-', '')
      $bytes = $certificates.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $password)
      $options += @('/p', $password)
    }
    [IO.File]::WriteAllBytes($pfx, $bytes)
    foreach ($batch in $batches) {
      & $signtool @options @batch 2>&1 | ForEach-Object { [string]$_ }
      if ($LASTEXITCODE -ne 0) { throw "signtool exited with $LASTEXITCODE" }
    }
  } finally {
    Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
    # Deletes the temporary key containers the import created.
    foreach ($certificate in $certificates) { $certificate.Reset() }
  }
} elseif ($unsigned.Count -gt 0) {
  # As electron-builder installs it for the desktop installer.
  if (-not (Get-Module -ListAvailable -Name TrustedSigning | Where-Object { $_.Version -ge [version]'0.5.0' })) {
    try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null } catch { }
    Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser
  }
  Import-Module TrustedSigning -MinimumVersion 0.5.0
  foreach ($batch in $batches) {
    if (@($batch | Where-Object { $_.Contains(',') }).Count -gt 0) { throw 'Invoke-TrustedSigning cannot sign a path containing a comma' }
    Invoke-TrustedSigning -Endpoint $env:AZURE_SIGNING_ENDPOINT -CodeSigningAccountName $env:AZURE_SIGNING_ACCOUNT -CertificateProfileName $env:AZURE_SIGNING_PROFILE -Files ($batch -join ',') -FileDigest SHA256 -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256 *>&1 | ForEach-Object { [string]$_ }
  }
}
$failed = @(foreach ($file in $unsigned) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) { "$file ($($signature.Status))" }
})
if ($failed.Count -gt 0) { throw ('not validly signed and timestamped: ' + ($failed -join '; ')) }
foreach ($file in $unsigned) { Write-Output "signed $($file.Substring($root.Length).TrimStart('\'))" }
`;

/** `certificate`, `azure` or `none`, from PUDDLE_WINDOWS_SIGNING. */
export function windowsSigningMode(env = process.env) {
  const mode = env.PUDDLE_WINDOWS_SIGNING ?? '';
  if (mode === '' || mode === 'none') return 'none';
  if (mode === 'certificate' || mode === 'azure') return mode;
  throw new Error(`PUDDLE_WINDOWS_SIGNING must be certificate, azure or none, not ${mode}`);
}

const REQUIRED = {
  certificate: ['WIN_CSC_LINK'],
  azure: ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE'],
};

/**
 * Signs the tree at `root` when a signing mode is selected, and resolves
 * whether it did; without one it returns false at once and touches nothing.
 * `run(script, env, log)` executes the PowerShell script (injectable for
 * tests), passing each line it prints to `log`.
 */
export async function signWindowsTree(
  root,
  log = console.log,
  { scripts = false, env = process.env, run = runWindowsPowerShell } = {},
) {
  const mode = windowsSigningMode(env);
  if (mode === 'none') return false;
  const missing = REQUIRED[mode].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`${mode} signing needs ${missing.join(', ')}`);
  }
  log(`signing ${root} (${mode})`);
  await run(
    SIGN_SCRIPT,
    {
      ...env,
      PUDDLE_WINDOWS_SIGNING: mode,
      PUDDLE_SIGN_ROOT: root,
      PUDDLE_SIGN_SCRIPTS: scripts ? '1' : '0',
      PUDDLE_TIMESTAMP_URL: env.PUDDLE_TIMESTAMP_URL || 'http://timestamp.digicert.com',
    },
    log,
  );
  return true;
}

/**
 * System32's Windows PowerShell, which every supported Windows has. Its
 * output lines go to `log`; a failure rejects with the script's own message.
 */
function runWindowsPowerShell(script, env, log) {
  const powershell = join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        // Process scope only: the TrustedSigning module is a script module.
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let pending = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line.trim() !== '') log(`windows-sign: ${line}`);
    });
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending.trim() !== '') log(`windows-sign: ${pending}`);
      // -EncodedCommand reports module loading as CLIXML progress records.
      const message = errors
        .replace(/<Objs\b[\s\S]*?<\/Objs>/g, '')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && line.trim() !== '#< CLIXML')
        .join('\n');
      if (code === 0) resolve();
      else reject(new Error(`Authenticode signing failed: ${message || `exit ${code}`}`));
    });
  });
}
