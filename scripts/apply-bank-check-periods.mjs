import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-bank-check-periods.mjs',
  defaultFiles:['20260903110000_bank_check_periods.sql'],
  allowFileArgument:false
});
