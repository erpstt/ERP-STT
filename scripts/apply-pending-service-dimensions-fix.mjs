import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-pending-service-dimensions-fix.mjs',defaultFiles:['20261001100000_fix_pending_service_dimensions.sql'],allowFileArgument:false});
