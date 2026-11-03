/**
 * What an OpenSSH askpass invocation is asking for. Windows OpenSSH
 * (OpenSSH_for_Windows 9.5p2, verified) rewrites every `/` in the prompt
 * argument to `\`, so a host-key question arrives as
 * `(yes\no\[fingerprint])?` and its SHA256 fingerprint carries `\` where the
 * base64 had `/`.
 */
export function askpassKind(
  prompt: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): 'confirm' | 'secret' {
  const question =
    platform === 'win32'
      ? /\(yes[\\/]no(?:[\\/][^)]+)?\)\??\s*$/i
      : /\(yes\/no(?:\/[^)]+)?\)\??\s*$/i;
  return env.SSH_ASKPASS_PROMPT === 'confirm' || question.test(prompt) ? 'confirm' : 'secret';
}

/**
 * The prompt as OpenSSH wrote it. Only tokens that never contain a real
 * backslash are restored: SHA256 fingerprints (base64) and the yes/no
 * choices. Paths in passphrase prompts keep their Windows separators.
 */
export function askpassPrompt(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return prompt;
  return prompt
    .replace(/SHA256:[A-Za-z0-9+\\/=]+/g, (fingerprint) => fingerprint.replaceAll('\\', '/'))
    .replace(/\(yes\\no(?:\\[^)]+)?\)/gi, (choices) => choices.replaceAll('\\', '/'));
}
