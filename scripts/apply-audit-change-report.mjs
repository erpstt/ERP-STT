import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-audit-change-report.mjs',
  defaultFiles:[
    '20261019110000_audit_change_report.sql',
    '20261019120000_optimize_audit_change_report.sql',
    '20261019130000_audit_transaction_change_report.sql'
  ],
  allowFileArgument:false
});
