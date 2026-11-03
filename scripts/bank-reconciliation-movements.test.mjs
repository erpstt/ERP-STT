import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bankMovementGroups,bankMovementPage,completeBankMovementReport} from '../public/bank-reconciliation-movements.js';

const row=(id,status='PENDIENTE_EN_TRANSITO')=>({id,reconciliation_status:status});
const response=(rows,total,page=1,pageSize=2,extra={})=>({rows,total,page,pageSize,...extra});

test('solo el estado canónico conciliado pasa al apartado completado sin modificar las fuentes',()=>{
  const data={rows:[row(0,' conciliado '),row(1),row(2,''),{id:3,status:'CONCILIADO'},{id:4,status:'MATCHED'},{id:5,reconciliation_status:0},{id:6}],statementLines:[{statement_line_id:7,reconciliation_status:'CONCILIADO'},{statement_line_id:8,reconciliation_status:'PENDIENTE'}]};
  const original=structuredClone(data),groups=bankMovementGroups(data);
  assert.deepEqual(groups.reconciled.rows.map(item=>item.id),[0,3]);
  assert.deepEqual(groups.pending.rows.map(item=>item.id),[1,2,4,5,6]);
  assert.equal(groups.reconciled.statementLines[0].statement_line_id,7);
  assert.equal(groups.pending.statementLines[0].statement_line_id,8);
  assert.deepEqual(data,original);
  assert.deepEqual(bankMovementGroups(null),{pending:{rows:[],statementLines:[]},reconciled:{rows:[],statementLines:[]}});
});

test('pagina ambos lados de pendientes y conciliados por sus propios índices y conserva los conteos',()=>{
  const data={rows:[row(1),row(2,'CONCILIADO'),row(3),row(4,'CONCILIADO'),row(5)],statementLines:[{statement_line_id:10,reconciliation_status:'CONCILIADO'},{statement_line_id:11,reconciliation_status:'PENDIENTE'},{statement_line_id:12,reconciliation_status:'PENDIENTE'},{statement_line_id:13,reconciliation_status:'PENDIENTE'},{statement_line_id:14,reconciliation_status:'PENDIENTE'}]};
  const pending=bankMovementPage(data,'WORKSPACE',2,2);
  assert.deepEqual(pending.rows.map(item=>item.id),[5]);
  assert.deepEqual(pending.statementLines.map(item=>item.statement_line_id),[13,14]);
  assert.deepEqual({total:pending.total,page:pending.page,pageSize:pending.pageSize,erpTotal:pending.erpTotal,statementTotal:pending.statementTotal},{total:4,page:2,pageSize:2,erpTotal:3,statementTotal:4});
  assert.deepEqual(pending.counts,{pending:{erp:3,statement:4},reconciled:{erp:2,statement:1}});
  const reconciled=bankMovementPage(data,'RECONCILED',99,1);
  assert.equal(reconciled.page,2);assert.deepEqual(reconciled.rows.map(item=>item.id),[4]);assert.deepEqual(reconciled.statementLines,[]);
  assert.equal(bankMovementPage(data,'WORKSPACE',-1,0).page,1);
  assert.equal(bankMovementPage(data,'WORKSPACE',-1,0).pageSize,50);
  assert.equal(bankMovementPage({},'RECONCILED',50,50).page,1);
});

test('completa páginas posteriores para encontrar pendientes que no estaban en la primera',async()=>{
  const initial=response([row(1,'CONCILIADO'),row(2,'CONCILIADO')],5,1,2,{summary:{bookBalance:50},statementLines:[]}),calls=[];
  const all=await completeBankMovementReport(initial,async(page,pageSize)=>{
    calls.push([page,pageSize]);
    return response(page===2?[row(3,'CONCILIADO'),row(4)]:[row(5)],5,page,pageSize,{summary:{bookBalance:50},statementLines:[]});
  });
  assert.deepEqual(calls,[[2,2],[3,2]]);
  assert.deepEqual(all.rows.map(item=>item.id),[1,2,3,4,5]);assert.equal(all.total,5);assert.equal(all.bankMovementsComplete,true);
  assert.deepEqual(bankMovementGroups(all).pending.rows.map(item=>item.id),[4,5]);
  assert.equal(initial.rows.length,2);
});

test('limita la concurrencia a dos y ordena los resultados por página aunque terminen fuera de orden',async()=>{
  let active=0,maximum=0;
  const all=await completeBankMovementReport(response([row(1)],6,1,1),async(page,pageSize)=>{
    active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,page===2?15:1));active--;
    return response([row(page)],6,page,pageSize);
  });
  assert.equal(maximum,2);assert.deepEqual(all.rows.map(item=>item.id),[1,2,3,4,5,6]);
});

test('aprovecha una página inicial distinta de la primera y honra su tamaño devuelto',async()=>{
  const calls=[];
  const all=await completeBankMovementReport(response([row(3),row(4)],5,2,2),async(page,size)=>{
    calls.push([page,size]);return response(page===1?[row(1),row(2)]:[row(5)],5,page,size);
  });
  assert.deepEqual(calls,[[1,2],[3,2]]);assert.deepEqual(all.rows.map(item=>item.id),[1,2,3,4,5]);
});

test('un conjunto vacío o ya completo no genera consultas adicionales',async()=>{
  const never=async()=>assert.fail('No debe solicitar páginas adicionales.');
  assert.equal((await completeBankMovementReport(response([],0,1,50),never)).bankMovementsComplete,true);
  const first=await completeBankMovementReport(response([row(1)],1,1,50),never);
  assert.deepEqual((await completeBankMovementReport(first,never)).rows,[row(1)]);
});

test('rechaza conteos o páginas inconsistentes en lugar de ocultar pendientes',async()=>{
  const initial=response([row(1),row(2)],4);
  const invalid=[response([row(3),row(4)],5,2),response([row(3)],4,2),response([row(3),row(4)],4,1),response([row(3),row(4)],4,2,10),response([row(2),row(3)],4,2),response([{},row(4)],4,2)];
  for(const next of invalid)await assert.rejects(completeBankMovementReport(initial,async()=>next),/cambiaron|completos/);
  await assert.rejects(completeBankMovementReport(response([row(1)],3,1,500),async()=>{}),/cambiaron|completos/);
  await assert.rejects(completeBankMovementReport(response([row(1),row(1)],2),async()=>{}),/cambiaron|completos/);
});

test('detecta cambios del extracto, resumen o conciliación durante la lectura de páginas',async()=>{
  for(const key of ['statementLines','summary','reconciliation']){
    const initial=response([row(1)],2,1,1,{[key]:key==='statementLines'?[{statement_line_id:7,reconciliation_status:'PENDIENTE'}]:{value:1}});
    const next=response([row(2)],2,2,1,{[key]:key==='statementLines'?[{statement_line_id:7,reconciliation_status:'CONCILIADO'}]:{value:2}});
    await assert.rejects(completeBankMovementReport(initial,async()=>next),/cambiaron|completos/);
  }
});

test('propaga el error de una página y no devuelve una conciliación incompleta',async()=>{
  const failure=new Error('falló la segunda página');
  await assert.rejects(completeBankMovementReport(response([row(1)],3,1,1),async()=>{throw failure;}),failure);
});

test('respeta cancelación previa y durante una carga cuyo proveedor ignora la señal',async()=>{
  const before=new AbortController();before.abort();
  await assert.rejects(completeBankMovementReport(response([],0),async()=>assert.fail(),before.signal),error=>error.name==='AbortError');
  const controller=new AbortController();let calls=0;
  await assert.rejects(completeBankMovementReport(response([row(1)],5,1,1),async(page,pageSize,signal)=>{
    assert.equal(signal,controller.signal);calls++;controller.abort();await Promise.resolve();return response([row(page)],5,page,pageSize);
  },controller.signal),error=>error.name==='AbortError');
  assert.ok(calls<=2);
});
