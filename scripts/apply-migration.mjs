import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-migration.mjs',
  defaultFiles:[],
  allowFileArgument:true,
  requireFile:true
});
