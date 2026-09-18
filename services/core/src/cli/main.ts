#!/usr/bin/env node
import 'reflect-metadata';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';
import { Command } from 'commander';
import { SYSTEM_DB_ROLE } from '../modules/tenants/system-prisma.module.js';
import { createOperator } from './create-operator.js';

const MIN_PASSWORD_LENGTH = 12;

const program = new Command();

program
  .command('create-operator')
  .description('Bootstrap the first platform operator (idempotent, no HTTP involved).')
  .requiredOption('--email <email>', 'operator email')
  .requiredOption('--password <password>', `operator password (min ${MIN_PASSWORD_LENGTH} chars)`)
  .action(async (opts: { email: string; password: string }) => {
    if (opts.password.length < MIN_PASSWORD_LENGTH) {
      console.error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      process.exitCode = 1;
      return;
    }
    const prisma = withTenantScope(new PrismaClient(), { systemRole: SYSTEM_DB_ROLE });
    try {
      const result = await createOperator(prisma, { email: opts.email, password: opts.password });
      console.log(
        result.created
          ? `created operator ${opts.email} (${result.userId})`
          : `operator ${opts.email} already exists (${result.userId})`
      );
    } finally {
      await prisma.$disconnect();
    }
  });

void program.parseAsync(process.argv);
