import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const migration=await readFile(new URL('../supabase/migrations/20261029160000_user_language_preference.sql',import.meta.url),'utf8');

test('la preferencia queda ligada al usuario y al catálogo activo de idiomas',()=>{
  assert.match(migration,/add column if not exists language_id bigint references public\.languages/i);
  assert.match(migration,/where is_active[\s\S]*app_supported_language_locale/i);
  assert.match(migration,/where user_id=current_user_id/i);
  assert.match(migration,/grant execute on function public\.set_user_language_preference\(text\) to authenticated,service_role/i);
  assert.doesNotMatch(migration,/grant update\s*\([^)]*language_id/i,'No debe ampliarse el UPDATE directo sobre usuarios.');
});

