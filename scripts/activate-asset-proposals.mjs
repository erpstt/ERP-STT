// Preview only: installation and checks using a real selected session/report
// are disabled. This manifest does not claim installed or operational status.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/activate-asset-proposals.mjs',defaultFiles:['20260917140000_fixed_asset_capitalization_proposals.sql'],allowFileArgument:false});
