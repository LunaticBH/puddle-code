import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { CliError, type Logger } from '../lib/types.js';
import { cliVersion, repoSlug } from '../lib/version.js';
import {
  standaloneInstallation,
  upgradeStandaloneCli,
  removeStandaloneCli,
} from '../lib/installation/standalone-cli.js';
import { confirm } from './prompt.js';

/** Preserve the installation channel when replacing the running CLI. */
export function upgradeCli(version: string | undefined, logger: Logger): Promise<number> {
  const standalone = standaloneInstallation();
  if (standalone) {
    logger.info(`upgrading standalone CLI ${cliVersion()} to ${version ?? 'the latest release'}`);
    return upgradeStandaloneCli(standalone, version, repoSlug());
  }
  const spec = `@puddle-code/cli@${version ?? 'latest'}`;
  logger.info(`puddle CLI ${cliVersion()} — asking npm for ${version ?? 'the latest release'}`);
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', spec], { stdio: 'inherit' });
    child.on('error', () =>
      reject(
        new CliError(
          'not_installed',
          'npm is not on PATH',
          `the CLI is installed and upgraded via npm: npm install -g ${spec}`,
        ),
      ),
    );
    child.on('exit', (code) => {
      if (code === 0) {
        logger.info('done — `puddle --version` shows the installed version');
        resolve(0);
      } else {
        reject(new CliError('not_installed', `npm install exited with ${code ?? 'a signal'}`));
      }
    });
  });
}

export async function removeCli(yes: boolean, logger: Logger): Promise<number> {
  const standalone = standaloneInstallation();
  if (standalone) {
    const proceed = await confirm(
      `Remove the standalone CLI at ${standalone.root} and its launcher in ${dirname(standalone.launcher)}? Close its cockpits first; daemons and their sessions are untouched.`,
      { skip: yes },
    );
    if (!proceed) {
      logger.info('nothing removed');
      return 0;
    }
    await removeStandaloneCli(standalone);
    logger.info('removed the standalone CLI — daemon installations and data are untouched');
    return 0;
  }
  // Only an npm-global install can be removed the way it arrived; a repo
  // checkout or a linked dev build is not ours to delete.
  const managed = await new Promise<boolean>((resolve) => {
    const child = spawn('npm', ['ls', '-g', '@puddle-code/cli', '--depth=0'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  if (!managed) {
    throw new CliError(
      'not_installed',
      'the puddle CLI is not an npm global install on this machine',
      'a repo checkout or linked dev build is removed the way it was installed',
    );
  }
  const proceed = await confirm(
    `Remove the puddle CLI (npm uninstall -g @puddle-code/cli)? Running cockpits keep ` +
      `running until killed; daemons and their sessions are untouched.`,
    { skip: yes },
  );
  if (!proceed) {
    logger.info('nothing removed');
    return 0;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['uninstall', '-g', '@puddle-code/cli'], { stdio: 'inherit' });
    child.on('error', () => reject(new CliError('not_installed', 'npm is not on PATH')));
    child.on('exit', (code) => {
      if (code === 0) {
        logger.info('removed — daemons keep running (puddle remove daemon uninstalls one)');
        resolve(0);
      } else {
        reject(new CliError('not_installed', `npm uninstall exited with ${code ?? 'a signal'}`));
      }
    });
  });
}
