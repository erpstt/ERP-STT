import {readFile} from 'node:fs/promises';
import {setupCxpSubsidiaryApproval} from './setup-cxp-subsidiary-approval.mjs';

export const upAdministrativeMigration='20261110175511_require_administrative_approval_after_project_approval.sql';

export async function applyOtherPaymentUpAdministrative(db){
 const sql=(await readFile(new URL('../../supabase/migrations/'+upAdministrativeMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await db.exec('reset role;begin');
 try{await db.exec(sql);await db.exec('commit');}
 catch(error){await db.exec('rollback');throw error;}
}

// In-memory PostgreSQL only. Uses the real security, routing, state and payment
// engines from the existing CxP fixture; no remote credentials or services.
export async function setupOtherPaymentUpAdministrative(db,{apply=true}={}){
 await setupCxpSubsidiaryApproval(db);
 await db.exec(`
  update subsidiaries set administrative_approver='user:11',default_up_approver_id=3 where subsidiary_id=1;
  update cost_centers set is_inactive=false,department_id=20,cost_center_type='CLIENTE',up_approver_id=2,code='SYN-UP-40' where cost_center_id=40;
  insert into cost_centers(cost_center_id,name,customer_id,class_id,subsidiary_id,is_inactive,department_id,cost_center_type,up_approver_id,code)
    values(41,'Synthetic second UP center',10,30,1,false,20,'CLIENTE',3,'SYN-UP-41');
 `);
 if(apply)await applyOtherPaymentUpAdministrative(db);
}
