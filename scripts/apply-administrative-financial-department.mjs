import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-administrative-financial-department.mjs',defaultFiles:['20261026200000_administrative_financial_department.sql'],allowFileArgument:false});
