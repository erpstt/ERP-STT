// Preview only: former installation, live verification and metric queries are disabled.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-supplier-invoice-payable-account-routing.mjs',defaultFiles:['20261020110000_supplier_invoice_payable_account_routing.sql'],allowFileArgument:false});
