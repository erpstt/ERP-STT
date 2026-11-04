import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-optimize-audit-report-options.mjs',
  defaultFiles:['20261023170000_optimize_audit_report_options.sql'],
  allowFileArgument:false
});
