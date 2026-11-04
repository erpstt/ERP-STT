// Preview source files only; former transaction-boundary rewriting,
// JWT-context option checks and business assertions are not executed.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-payment-request-tax-agency.mjs',defaultFiles:['20261027090000_tax_agency_payment_requests.sql','20261027101000_payment_request_tax_agency_reporting.sql'],allowFileArgument:false});
