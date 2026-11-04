import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-journal-csv-performance.mjs',
  defaultFiles:['20261026194500_optimize_journal_csv_lookups.sql'],
  allowFileArgument:false
});
