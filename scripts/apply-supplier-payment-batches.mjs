import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-supplier-payment-batches.mjs',
  defaultFiles:['20261003120000_supplier_payment_batches.sql'],
  allowFileArgument:false
});

