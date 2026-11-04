import{runMigrationPreview}from'./lib/migration-preview.mjs';
await runMigrationPreview({entrypoint:'scripts/apply-journal-csv-migration.mjs',defaultFiles:['20260908120000_import_journal_csv.sql','20260908130000_journal_csv_dimensions.sql'],allowFileArgument:false});
