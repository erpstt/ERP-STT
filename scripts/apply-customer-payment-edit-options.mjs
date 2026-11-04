import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-customer-payment-edit-options.mjs',
  defaultFiles:['20260930164000_customer_payment_edit_options.sql'],
  allowFileArgument:false
});
