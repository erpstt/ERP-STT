import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-vat-declaration-report.mjs',
  defaultFiles:['20261002150000_vat_declaration_report.sql'],
  allowFileArgument:false
});
