import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-sales-invoice-unified-pdf-description.mjs',defaultFiles:['20261018090000_sales_invoice_unified_pdf_description.sql'],allowFileArgument:false});
