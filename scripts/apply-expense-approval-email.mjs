import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-expense-approval-email.mjs',defaultFiles:['20261005100000_expense_approval_email_notifications.sql'],allowFileArgument:false});
