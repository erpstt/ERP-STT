import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-pending-journal-service-country.mjs',defaultFiles:['20261001090000_add_pending_journal_service_country.sql'],allowFileArgument:false});
