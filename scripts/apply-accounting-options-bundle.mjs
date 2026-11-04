import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-accounting-options-bundle.mjs',
  defaultFiles:['20261029210000_accounting_report_options_bundle.sql'],
  allowFileArgument:false
});
