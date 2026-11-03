import {mapWithConcurrency,sameRequestParameters} from './frontend-performance.js?v=20261023-second-pass-v3';

function completed(row){
  return String(row?.reconciliation_status??row?.status??'').trim().toUpperCase()==='CONCILIADO';
}

/** Keep the original collections intact for totals, exports and other bank views. */
export function bankMovementGroups(data){
  const groups={pending:{rows:[],statementLines:[]},reconciled:{rows:[],statementLines:[]}};
  for(const key of ['rows','statementLines']){
    for(const row of Array.isArray(data?.[key])?data[key]:[])groups[completed(row)?'reconciled':'pending'][key].push(row);
  }
  return groups;
}

function positiveInteger(value,fallback){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:fallback;
}

/** Both sides use one local page so a shorter list leaves empty cells, never wrong pairings. */
export function bankMovementPage(data,mode,page=1,pageSize=50){
  const groups=bankMovementGroups(data),group=mode==='RECONCILED'?groups.reconciled:groups.pending;
  const size=positiveInteger(pageSize,50),erpTotal=group.rows.length,statementTotal=group.statementLines.length,total=Math.max(erpTotal,statementTotal);
  const current=Math.min(positiveInteger(page,1),Math.max(1,Math.ceil(total/size))),offset=(current-1)*size;
  return{
    rows:group.rows.slice(offset,offset+size),statementLines:group.statementLines.slice(offset,offset+size),
    total,page:current,pageSize:size,erpTotal,statementTotal,
    counts:{pending:{erp:groups.pending.rows.length,statement:groups.pending.statementLines.length},reconciled:{erp:groups.reconciled.rows.length,statement:groups.reconciled.statementLines.length}}
  };
}

function snapshotChanged(){
  return new Error('Los movimientos cambiaron o no se pudieron cargar completos. Actualice la conciliación y vuelva a intentarlo.');
}

function throwIfAborted(signal){
  if(!signal?.aborted)return;
  if(signal.reason)throw signal.reason;
  const failure=new Error('La consulta de movimientos fue cancelada.');failure.name='AbortError';throw failure;
}

function rowKey(row){
  const id=row?.id;
  if(!['string','number'].includes(typeof id)||String(id).trim()===''||typeof id==='number'&&!Number.isFinite(id))throw snapshotChanged();
  return String(id);
}

/**
 * A report page alone cannot be partitioned reliably: all its pending rows may
 * be on later pages. Complete the authorized ERP result before filtering it.
 */
export async function completeBankMovementReport(initial,loadPage,signal){
  throwIfAborted(signal);
  const expected=Number(initial?.total),initialRows=initial?.rows;
  if(!Number.isSafeInteger(expected)||expected<0||!Array.isArray(initialRows))throw snapshotChanged();
  if(initial.bankMovementsComplete){
    const keys=new Set(initialRows.map(rowKey));
    if(keys.size!==initialRows.length||keys.size!==expected)throw snapshotChanged();
    return{...initial,rows:[...initialRows],total:expected,bankMovementsComplete:true};
  }
  const pageSize=positiveInteger(initial.pageSize,initialRows.length||250),initialPage=positiveInteger(initial.page,1);
  if(pageSize>250)throw snapshotChanged();
  const pageCount=Math.max(1,Math.ceil(expected/pageSize));
  if(initialPage>pageCount)throw snapshotChanged();
  const validatePage=(report,pageNumber)=>{
    if(!report||!Array.isArray(report.rows)||Number(report.total)!==expected)throw snapshotChanged();
    if(report.pageSize!==undefined&&Number(report.pageSize)!==pageSize)throw snapshotChanged();
    if(report.page!==undefined&&Number(report.page)!==pageNumber)throw snapshotChanged();
    const required=Math.min(pageSize,Math.max(0,expected-(pageNumber-1)*pageSize));
    if(report.rows.length!==required)throw snapshotChanged();
    for(const key of ['summary','reconciliation','statementLines']){
      if(initial[key]!==undefined&&report[key]!==undefined&&!sameRequestParameters(initial[key],report[key]))throw snapshotChanged();
    }
    return report;
  };
  validatePage(initial,initialPage);
  const missing=Array.from({length:pageCount},(_,index)=>index+1).filter(pageNumber=>pageNumber!==initialPage);
  const responses=await mapWithConcurrency(missing,2,async pageNumber=>{
    throwIfAborted(signal);
    const result=await loadPage(pageNumber,pageSize,signal);
    throwIfAborted(signal);
    return{page:pageNumber,report:validatePage(result,pageNumber)};
  },signal);
  throwIfAborted(signal);
  const pages=[{page:initialPage,report:initial},...responses].sort((left,right)=>left.page-right.page),unique=new Map();
  for(const {report} of pages){
    for(const row of report.rows){
      const key=rowKey(row);
      if(unique.has(key))throw snapshotChanged();
      unique.set(key,row);
    }
  }
  if(unique.size!==expected)throw snapshotChanged();
  return{...initial,rows:[...unique.values()],total:expected,bankMovementsComplete:true};
}
