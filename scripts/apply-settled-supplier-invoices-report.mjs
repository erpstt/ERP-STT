import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-settled-supplier-invoices-report.mjs',defaultFiles:['20260930165000_settled_supplier_invoices_report.sql'],allowFileArgument:false});
