import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-quadratic-bank-reconciliation.mjs',defaultFiles:['20261001140000_quadratic_bank_reconciliation.sql','20261002090000_quadratic_list_month_filter.sql','20261002100000_quadratic_export_header.sql'],allowFileArgument:false});
