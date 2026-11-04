import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-role-access-matrix.mjs',
  defaultFiles:['20261012110000_role_access_matrix.sql'],
  allowFileArgument:false
});
