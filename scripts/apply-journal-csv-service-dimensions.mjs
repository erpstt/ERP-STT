import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-journal-csv-service-dimensions.mjs',
  defaultFiles:['20261026193000_normalize_journal_csv_service_dimensions.sql'],
  allowFileArgument:false
});
