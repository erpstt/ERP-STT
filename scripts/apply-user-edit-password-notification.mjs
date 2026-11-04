import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-user-edit-password-notification.mjs',
  defaultFiles:['20261027153000_user_edit_password_notification.sql'],
  allowFileArgument:false
});
