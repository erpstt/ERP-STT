import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-asset-category-export-header.mjs',
  defaultFiles:['20261020130000_asset_category_export_header.sql'],
  allowFileArgument:false
});
