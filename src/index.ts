#!/usr/bin/env node
import { createCLI } from './cli.js';
import chalk from 'chalk';

// グローバルエラーハンドラー
process.on('uncaughtException', (error) => {
  console.error(chalk.red('\n❌ Unexpected error occurred:'));
  console.error(chalk.red(error.message));
  if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
    console.error(chalk.gray('\nStack trace:'));
    console.error(chalk.gray(error.stack));
  } else {
    console.error(chalk.gray('\nRun with DEBUG=1 to see more details'));
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('\n❌ Unhandled promise rejection:'));
  console.error(chalk.red(String(reason)));
  if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
    console.error(chalk.gray('\nPromise:'), promise);
    if (reason instanceof Error) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(reason.stack));
    }
  } else {
    console.error(chalk.gray('\nRun with DEBUG=1 to see more details'));
  }
  process.exit(1);
});

const program = createCLI();
program.parse(process.argv);