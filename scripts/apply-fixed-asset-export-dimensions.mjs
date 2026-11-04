import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-fixed-asset-export-dimensions.mjs',
  defaultFiles:['20261020120000_fixed_asset_export_dimensions.sql'],
  allowFileArgument:false
});
