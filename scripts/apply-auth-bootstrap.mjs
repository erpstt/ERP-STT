import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-auth-bootstrap.mjs',
  defaultFiles:['20261029200000_auth_bootstrap_context.sql'],
  allowFileArgument:false
});
