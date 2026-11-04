import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-up-approver-routing.mjs',defaultFiles:['20261004100000_up_approver_routing.sql'],allowFileArgument:false});
