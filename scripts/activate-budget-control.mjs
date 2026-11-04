// Preview only: --apply and existing-schema/permission activation checks are
// disabled. This manifest does not claim installation or verified permissions.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/activate-budget-control.mjs',defaultFiles:['20260921120000_budget_control.sql'],allowFileArgument:false});
