import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-bank-transfer-migration.mjs',
  defaultFiles:['20260902090000_bank_account_transfers.sql'],
  allowFileArgument:false
});
