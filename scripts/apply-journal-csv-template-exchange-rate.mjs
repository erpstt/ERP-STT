import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-journal-csv-template-exchange-rate.mjs',
  defaultFiles:['20261026180000_journal_csv_template_exchange_rate.sql'],
  allowFileArgument:false
});
