import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-customer-payment-bank-fee.mjs',
  defaultFiles:['20261026130000_customer_payment_bank_fee.sql'],
  allowFileArgument:false
});
