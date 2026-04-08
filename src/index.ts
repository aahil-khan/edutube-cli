#!/usr/bin/env node
import { Command } from 'commander';
import { fetchCliHealth, fetchCliTree } from './lib/api.js';

const program = new Command();

program.name('edutube').description('EduTube workstation CLI').version('0.1.0');

program
    .command('health')
    .description('Check CLI API key and backend connectivity (GET /api/cli/health)')
    .action(async () => {
        try {
            const { data } = await fetchCliHealth();
            console.log(JSON.stringify(data, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program
    .command('tree')
    .description('Print full course tree JSON (GET /api/cli/tree)')
    .action(async () => {
        try {
            const { data } = await fetchCliTree();
            console.log(JSON.stringify(data, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program.parse();
