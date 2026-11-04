import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-request-access-role-context.mjs',
  defaultFiles:['20261029220000_assert_request_access_role_context.sql'],
  allowFileArgument:false
});
