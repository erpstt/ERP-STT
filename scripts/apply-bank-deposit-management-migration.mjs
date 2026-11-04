import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-bank-deposit-management-migration.mjs',
  defaultFiles:['20260902150000_manage_bank_deposits.sql'],
  allowFileArgument:false
});
