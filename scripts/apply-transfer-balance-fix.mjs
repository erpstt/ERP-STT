import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-transfer-balance-fix.mjs',
  defaultFiles:['20260903130000_fix_transfer_gl_balance.sql'],
  allowFileArgument:false
});
