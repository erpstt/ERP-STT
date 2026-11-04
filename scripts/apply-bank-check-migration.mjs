import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-bank-check-migration.mjs',
  defaultFiles:['20260903100000_bank_checks_transfers_transaction.sql'],
  allowFileArgument:false
});
