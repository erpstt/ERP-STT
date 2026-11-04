import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-audit-migration.mjs',
  defaultFiles:['20260826160000_enable_central_auditing.sql'],
  allowFileArgument:true
});
