// Preview only: former --verify database checks and --apply execution are disabled.
import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-opening-bank-auxiliary.mjs',defaultFiles:['20261021100000_opening_bank_auxiliary.sql','20261021110000_opening_bank_zero_balance.sql'],allowFileArgument:false});
