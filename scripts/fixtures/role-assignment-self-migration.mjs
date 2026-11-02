import {readFile} from 'node:fs/promises';
export const selfRoleMigration='20261102195425_allow_central_admin_add_own_operational_role.sql';
export async function installSelfRoleAssignment(db){
 await db.exec(await readFile(new URL('../../supabase/migrations/'+selfRoleMigration,import.meta.url),'utf8'));
}
