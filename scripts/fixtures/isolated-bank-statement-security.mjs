import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isolatedRoleTemplateDatabase} from './isolated-role-template-security.mjs';
export {assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,authId,authSession,hash} from './isolated-role-template-security.mjs';

const migration=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
const sha=sql=>createHash('sha256').update(sql).digest('hex');
function statement(sql,marker){
 const start=sql.indexOf(marker);
 assert.ok(start>=0&&sql.indexOf(marker,start+marker.length)===-1,'Expected one reviewed SQL statement: '+marker);
 let quote=null;
 for(let index=start;index<sql.length;index++){
  const char=sql[index];
  if(quote){if(char===quote){if(sql[index+1]===quote)index++;else quote=null;}continue;}
  if(char==='\''||char==='"'){quote=char;continue;}
  if(sql.startsWith('--',index)){const end=sql.indexOf('\n',index+2);index=end<0?sql.length:end;continue;}
  if(sql.startsWith('/*',index)){const end=sql.indexOf('*/',index+2);assert.ok(end>=0);index=end+1;continue;}
  if(char==='$'){
   const tag=/^\$[a-z0-9_]*\$/i.exec(sql.slice(index))?.[0];
   if(tag){const end=sql.indexOf(tag,index+tag.length);assert.ok(end>=0);index=end+tag.length-1;continue;}
  }
  if(char===';')return sql.slice(start,index+1);
 }
 throw Error('Unterminated reviewed SQL statement');
}
export async function bankStatementIsolationSql(){
 const blocks=[],manifest=[];
 const add=(source,label,sql)=>{blocks.push(sql);manifest.push({source,label,bytes:Buffer.byteLength(sql),sha256:sha(sql)});};
 const transferPath='scripts/fixtures/bank-transfer-security.sql';
 const transfer=(await readFile(new URL('./bank-transfer-security.sql',import.meta.url),'utf8')).replaceAll('\r\n','\n');
 const ddlStart=transfer.indexOf('alter table public.currencies'),ddlEnd=transfer.indexOf('update public.role_access_matrix');
 const seedStart=transfer.indexOf('insert into public.banks values');
 assert.ok(ddlStart>=0&&ddlEnd>ddlStart&&seedStart>ddlEnd);
 const bankDdl=transfer.slice(ddlStart,ddlEnd),bankSeed=transfer.slice(seedStart);
 assert.ok(!/create\s+policy/i.test(bankDdl+bankSeed),'Never install old bank policies');
 add(transferPath,'synthetic bank structures',bankDdl);
 add(transferPath,'synthetic bank/ledger seed',bankSeed);
 // Match the current banking PK spelling before original FK-bearing DDL.
 add('synthetic fixture','current transaction PK spelling','alter table public.bank_transaction rename column bank_transaction_id to bank_tran_id;');

 const tablesName='20260807020000_add_banking_operations.sql',tables=(await migration(tablesName)).replaceAll('\r\n','\n');
 for(const name of['bank_statement','bank_reconciliation'])add(tablesName,name+' table',statement(tables,'create table if not exists public.'+name+'('));
 const linesName='20260829150000_enhance_bank_reconciliation.sql',lines=(await migration(linesName)).replaceAll('\r\n','\n');
 add(linesName,'statement file metadata',statement(lines,'alter table public.bank_statement add column'));
 for(const name of['bank_statement_line','bank_reconciliation_match'])add(linesName,name+' table',statement(lines,'create table if not exists public.'+name+'('));
 const quadName='20261001140000_quadratic_bank_reconciliation.sql',quad=(await migration(quadName)).replaceAll('\r\n','\n');
 for(const name of['quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','quadratic_reconciliation_history'])add(quadName,name+' table only',statement(quad,'create table if not exists public.'+name+'('));

 const secureName='20261031125441_secure_bank_reconciliation.sql',secure=(await migration(secureName)).replaceAll('\r\n','\n');
 const schemaStart=secure.indexOf('create schema reconciliation_private;'),schemaEnd=secure.indexOf('create function reconciliation_private.identity()');
 assert.ok(schemaStart>=0&&schemaEnd>schemaStart);
 add(secureName,'private schema boundary',secure.slice(schemaStart,schemaEnd));
 const functions=['reconciliation_private.identity','reconciliation_private.access','reconciliation_private.allowed','reconciliation_private.finite','reconciliation_private.bank_scope','reconciliation_private.statement_mutable','reconciliation_private.can_read','public.save_bank_statement_metadata','public.delete_bank_statement'];
 for(const name of functions)add(secureName,name,statement(secure,'create function '+name+'('));
 add(secureName,'current raw table and column ACL loop',statement(secure,'do $$declare p record;t text;col record;'));
 for(const name of['statement_read','statement_line_read','reconciliation_read','reconciliation_match_read','bank_movement_read','quadratic_read','quadratic_item_read','quadratic_match_read','quadratic_history_read'])add(secureName,name,statement(secure,'create policy '+name+' '));
 add(secureName,'current statement scope bridge',statement(secure,'create or replace function public.bank_statement_in_active_subsidiary('));
 const aclStart=secure.indexOf('revoke all on function public.bank_statement_in_active_subsidiary('),aclEnd=secure.indexOf("notify pgrst,'reload schema';",aclStart);
 assert.ok(aclStart>=0&&aclEnd>aclStart);
 add(secureName,'private helper and metadata RPC ACLs',secure.slice(aclStart,aclEnd));
 const optionsName='20261027180000_bank_statement_account_options.sql';
 add(optionsName,'real account options RPC and ACLs',(await migration(optionsName)).replaceAll('\r\n','\n'));
 return{blocks,manifest};
}

/** Statement-only slice of current banking security on synthetic data. No Oct26
 * bank policies, legacy financial functions, real actors or real transactions.
 * Reuses actual A06/session/device fixtures; unrelated reconciliation branches
 * have structural tables only and are outside this fixture's behavioral scope.
 */
export async function isolatedBankStatementDatabase(){
 const db=await isolatedRoleTemplateDatabase();
 try{
  const {blocks,manifest}=await bankStatementIsolationSql();
  for(const sql of blocks)await db.exec(sql);
  await db.exec(`insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values
   (1,'banking:bank-statements',true,true,true,true),
   (2,'banking:bank-statements',true,false,true,false),
   (3,'banking:bank-statements',true,false,false,false),
   (4,'banking:bank-statements',false,false,false,false);
   insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance,source_file_name)
   values('2026-10-31',1,100,125,'synthetic-a.csv'),('2026-10-31',3,200,230,'synthetic-b.csv');
   insert into bank_statement_line(statement_id,bank_date,reference,amount,source_row)
   values(1,'2026-10-15','SYNTHETIC-A',25,1),(2,'2026-10-15','SYNTHETIC-B',30,1);`);
  return{db,manifest};
 }catch(error){await db.close();throw error;}
}
