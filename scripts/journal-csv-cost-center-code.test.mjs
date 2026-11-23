import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('CSV cost centers accept names, codes and explicit IDs within the active subsidiary',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create function active_subsidiary_id() returns bigint language sql as $$select 1::bigint$$;
   create table cost_centers(cost_center_id bigint,code text,name text,subsidiary_id bigint,is_inactive boolean);
   insert into cost_centers values(1,'CC-001','Proyecto Jamaica',1,false),(2,'CC-002','Otro proyecto',1,false),(3,'CC-003','Inactivo',1,true),(4,'CC-004','Otra empresa',2,false),(5,'CC-005','Duplicado',1,false),(6,'CC-006','Duplicado',1,false),(7,'Proyecto Jamaica','Conflicto',2,false);`);
  await db.exec(await readFile('scripts/journal-csv-cost-center-code.sql','utf8'));
  const lookup=async v=>(await db.query("select journal_csv_lookup('centro_costos',$1) r",[v])).rows[0].r;
  for(const v of ['Proyecto Jamaica','proyecto jamaica',' CC-001 ','cc-001','ID:1'])assert.equal((await lookup(v)).cost_center_id,1);
  assert.equal(await lookup(''),null);
  for(const v of ['CC-003','CC-004','No existe','Duplicado'])await assert.rejects(lookup(v));
  await db.exec("insert into cost_centers values(8,'CC-X','CC-001',1,false)");
  await assert.rejects(lookup('CC-001'));
  assert.equal((await lookup('ID:1')).cost_center_id,1);
  await db.exec("select set_config('nexo.journal_csv_lookup_cache_enabled','on',false)");
  assert.equal((await lookup('CC-002')).cost_center_id,2);
 }finally{await db.close();}
});
