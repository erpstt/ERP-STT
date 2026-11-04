import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-entity-catalog-export.mjs',
  defaultFiles:['20261020090000_entity_catalog_exports.sql'],
  allowFileArgument:false
});
