import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/fix-scheduled-report-context-access.mjs',
  defaultFiles:['20260922010000_restore_session_subsidiary_function_access.sql'],
  allowFileArgument:false
});
