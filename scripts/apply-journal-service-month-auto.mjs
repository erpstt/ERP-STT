import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-journal-service-month-auto.mjs',
  defaultFiles:['20261026190000_automatic_journal_service_month.sql'],
  allowFileArgument:false
});
