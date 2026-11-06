import{readFile}from'node:fs/promises';
import{setupPaymentRequestApprovedEmail,applyPaymentRequestApprovedEmailMigration}from'./setup-payment-request-approved-email.mjs';
export const reminderMigration='20261106014202_add_payment_request_approval_reminders.sql';
const read=path=>readFile(new URL(path,import.meta.url),'utf8').then(source=>source.replace(/\r\n/g,'\n'));
export async function setupPaymentRequestApprovalReminder(db){
 await setupPaymentRequestApprovedEmail(db);
 await applyPaymentRequestApprovedEmailMigration(db);
 // Production catalog contract: display name plus an explicit UTC offset.
 await db.exec(`alter table timezones add column utc_offset varchar;update timezones set name='América / Costa Rica',utc_offset='UTC-06:00';`);
}
export async function applyPaymentRequestApprovalReminder(db){
 await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+reminderMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
export async function assumeReminderActor(db,user=1,role=1,sid=1){
 await db.exec('reset role');
 await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);
 await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture',role:'authenticated'})]);await db.exec('set role authenticated');
}
export async function assumeReminderService(db){
 await db.exec('reset role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);await db.exec('set role service_role');
}
