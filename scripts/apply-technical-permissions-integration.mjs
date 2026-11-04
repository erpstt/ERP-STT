import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-technical-permissions-integration.mjs',
  defaultFiles:['20261012130000_secure_and_integrate_technical_permissions.sql'],
  allowFileArgument:false
});
