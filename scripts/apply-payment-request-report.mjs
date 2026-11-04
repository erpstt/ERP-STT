import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-payment-request-report.mjs',
  defaultFiles:['20261002130000_payment_request_report.sql'],
  allowFileArgument:false
});
