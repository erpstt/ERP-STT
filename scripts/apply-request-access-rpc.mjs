import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-request-access-rpc.mjs',
  defaultFiles:['20261023183000_assert_request_access_rpc.sql'],
  allowFileArgument:false
});
