import {runMigrationPreview} from './lib/migration-preview.mjs';

await runMigrationPreview({
  entrypoint:'scripts/apply-general-journal-posted-lines.mjs',
  defaultFiles:['20261002110000_fix_general_journal_posted_lines.sql'],
  allowFileArgument:false
});
