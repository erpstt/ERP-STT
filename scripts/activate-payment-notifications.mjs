// Preview only: installation, notification environment guards and live queue/
// template checks are disabled. This manifest does not claim SMTP/send state.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/activate-payment-notifications.mjs',defaultFiles:['20260920120000_supplier_payment_email_notifications.sql'],allowFileArgument:false});
