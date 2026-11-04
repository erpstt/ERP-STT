import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-customer-payment-exchange-rate-integrity.mjs',
  defaultFiles:['20261026140000_customer_payment_exchange_rate_integrity.sql'],
  allowFileArgument:false
});
