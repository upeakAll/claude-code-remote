#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from '../dist/cli/init.js';
import { startCommand } from '../dist/cli/start.js';
import { stopCommand } from '../dist/cli/stop.js';
import { statusCommand } from '../dist/cli/status.js';
import { logCommand } from '../dist/cli/log.js';

const program = new Command();

program
  .name('claude-remote')
  .description('Remote control Claude Code via Feishu bot')
  .version('0.1.0');

program.addCommand(initCommand());
program.addCommand(startCommand());
program.addCommand(stopCommand());
program.addCommand(statusCommand());
program.addCommand(logCommand());

program
  .command('register')
  .description('Register CC session with bridge server (run from within CC)')
  .action(async () => {
    const { doRegisterAction } = await import('../dist/cli/register.js');
    await doRegisterAction();
  });

program
  .command('remote-status')
  .description('Show remote session status')
  .action(async () => {
    const { doStatusAction } = await import('../dist/cli/register.js');
    await doStatusAction();
  });

program.parse();
