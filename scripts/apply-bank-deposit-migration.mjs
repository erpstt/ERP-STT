import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-bank-deposit-migration.mjs',
  defaultFiles:['20260902130000_bank_deposit_transaction.sql'],
  allowFileArgument:false
});
