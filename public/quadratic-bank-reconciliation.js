const $ = id => document.getElementById(id);
const BASE = '/api/v1/bank-reconciliations/quadratic';
const token = () => localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token') || '';
const device = () => localStorage.getItem('nexo_device_token') || sessionStorage.getItem('nexo_device_token') || '';
const MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const ITEM_LABELS = {
  DEPOSIT_IN_TRANSIT_CURRENT:'Depósito en tránsito · mes actual',
  DEPOSIT_IN_TRANSIT_PRIOR:'Depósito en tránsito · mes anterior',
  OUTSTANDING_CHECK_CURRENT:'Cheque/pago pendiente · mes actual',
  OUTSTANDING_CHECK_PRIOR:'Cheque/pago pendiente · mes anterior',
  UNRECORDED_BANK_CHARGE:'Cargo bancario no registrado',
  UNRECORDED_BANK_CREDIT:'Abono bancario no registrado',
  BOOK_ERROR:'Error o corrección en libros',
  BANK_ERROR:'Error o corrección del banco'
};
const BANK_TYPES = new Set(['DEPOSIT_IN_TRANSIT_CURRENT','DEPOSIT_IN_TRANSIT_PRIOR','OUTSTANDING_CHECK_CURRENT','OUTSTANDING_CHECK_PRIOR','BANK_ERROR']);
const state = {options:{},history:[],detail:null,currentId:null,selectedStatementId:null,selectedBookId:null,busy:false};

function unwrap(value){return value?.result ?? value?.data ?? value ?? {};}
function rows(value,...keys){for(const key of keys){if(Array.isArray(value?.[key]))return value[key];}return Array.isArray(value)?value:[];}
function pick(source,...keys){for(const key of keys)if(source?.[key]!==undefined&&source?.[key]!==null)return source[key];return null;}
function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0;}
function parseMoney(value){
  let text=String(value??'').trim().replace(/[^\d,.-]/g,'');
  if(!text)return 0;
  const comma=text.lastIndexOf(','),dot=text.lastIndexOf('.');
  if(comma>=0&&dot>=0)text=comma>dot?text.replaceAll('.','').replace(',','.'):text.replaceAll(',','');
  else if(comma>=0)text=text.replaceAll('.','').replace(',','.');
  else if((text.match(/\./g)||[]).length>1)text=text.replaceAll('.','');
  const parsed=Number(text);return Number.isFinite(parsed)?parsed:0;
}
function editMoney(value){return number(value).toFixed(2).replace('.',',');}
function money(value){
  const n=number(value),symbol=currencySymbol(),formatted=Math.abs(n).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
  return n<0?`(${symbol} ${formatted})`:`${symbol} ${formatted}`.trim();
}
function dateLabel(value){if(!value)return '—';const date=new Date(String(value).length===10?`${value}T12:00:00`:value);return Number.isNaN(date.valueOf())?String(value):date.toLocaleDateString('es-CR',{day:'2-digit',month:'short',year:'numeric'});}
function setMessage(text='',kind='success'){$('message').textContent=text;$('message').className=`message${kind==='error'?' error':''}`;}
function setBusy(busy){state.busy=busy;document.querySelector('.page-shell').classList.toggle('loading',busy);document.querySelector('.page-shell').setAttribute('aria-busy',String(busy));}
function errorMessage(error){return error instanceof Error?error.message:'No fue posible completar la operación.';}

async function api(path,init={}){
  if(!token())throw Error('La sesión no está disponible. Inicie sesión nuevamente.');
  const response=await fetch(path,{...init,headers:{Authorization:`Bearer ${token()}`,'X-Device-Token':device(),...(init.body?{'Content-Type':'application/json'}:{}),...(init.headers||{})}});
  const raw=await response.text();let data=null;
  try{data=raw?JSON.parse(raw):null}catch{data={message:raw};}
  if(!response.ok)throw Error(data?.error?.message||data?.message||`No fue posible completar la operación (${response.status}).`);
  return data;
}

function currencySymbol(){
  const header=headerData(),account=selectedAccount();
  return String(pick(header,'currencySymbol','currency_symbol','symbol')||pick(account,'currency_symbol','currencySymbol','symbol','currency_code','currencyCode')||pick(state.options,'currencySymbol','currency_symbol')||'').trim();
}
function selectedAccount(){const id=$('bankAccount').value;return bankAccounts().find(item=>String(pick(item,'id','bankAccountId','bank_account_id'))===String(id))||{};}
function bankAccounts(){return rows(state.options,'bankAccounts','bank_accounts','accounts');}
function reconciliationId(item){return pick(item,'id','reconciliationId','reconciliation_id','quadraticReconciliationId','quadratic_reconciliation_id');}
function headerData(){return state.detail?.header||state.detail?.reconciliation||state.detail||{};}
function status(){return String(pick(headerData(),'status')||'draft').toLowerCase();}
function isClosed(){return status()==='closed';}
function permissions(){return state.detail?.permissions||state.options?.permissions||{};}
function canManage(){return permissions().manage!==false;}
function canApprove(){return permissions().approve!==false;}

function vector(source={}){
  if(Array.isArray(source))return{start:number(source[0]),receipts:number(source[1]),disbursements:number(source[2]),end:number(source[3])};
  return{
    start:number(pick(source,'start','initial','startBalance','start_balance','bankStartBalance','bank_start_balance','bookStartBalance','book_start_balance')),
    receipts:number(pick(source,'receipts','income','deposits','totalReceipts','total_receipts','bankTotalReceipts','bank_total_receipts','bookTotalReceipts','book_total_receipts')),
    disbursements:number(pick(source,'disbursements','expenses','withdrawals','totalDisbursements','total_disbursements','bankTotalDisbursements','bank_total_disbursements','bookTotalDisbursements','book_total_disbursements')),
    end:number(pick(source,'end','final','endBalance','end_balance','bankEndBalance','bank_end_balance','bookEndBalance','book_end_balance'))
  };
}
function add(a,b){return{start:a.start+b.start,receipts:a.receipts+b.receipts,disbursements:a.disbursements+b.disbursements,end:a.end+b.end};}
function subtract(a,b){return{start:a.start-b.start,receipts:a.receipts-b.receipts,disbursements:a.disbursements-b.disbursements,end:a.end-b.end};}
function impact(item){return vector({start:pick(item,'impactStartBalance','impact_start_balance'),receipts:pick(item,'impactReceipts','impact_receipts'),disbursements:pick(item,'impactDisbursements','impact_disbursements'),end:pick(item,'impactEndBalance','impact_end_balance')});}
function reconciliationItems(){return rows(state.detail,'items','reconciliationItems','reconciliation_items');}
function sumItems(items){return items.reduce((total,item)=>add(total,impact(item)),vector());}
function normalizedMatrix(){
  const root=state.detail||{},matrix=root.matrix||root.calculation||root.summary?.matrix||{},header=headerData(),items=reconciliationItems();
  const bankBase=vector(matrix.bankBase||matrix.bank_base||matrix.bankValues||matrix.bank_values||{
    bankStartBalance:pick(header,'bankStartBalance','bank_start_balance'),bankTotalReceipts:pick(header,'bankTotalReceipts','bank_total_receipts'),bankTotalDisbursements:pick(header,'bankTotalDisbursements','bank_total_disbursements'),bankEndBalance:pick(header,'bankEndBalance','bank_end_balance')
  });
  const bookBase=vector(matrix.bookBase||matrix.book_base||matrix.bookValues||matrix.book_values||{
    bookStartBalance:pick(header,'bookStartBalance','book_start_balance'),bookTotalReceipts:pick(header,'bookTotalReceipts','book_total_receipts'),bookTotalDisbursements:pick(header,'bookTotalDisbursements','book_total_disbursements'),bookEndBalance:pick(header,'bookEndBalance','book_end_balance')
  });
  const bankItems=items.filter(item=>BANK_TYPES.has(String(pick(item,'itemType','item_type')).toUpperCase()));
  const bookItems=items.filter(item=>!BANK_TYPES.has(String(pick(item,'itemType','item_type')).toUpperCase()));
  const bankAdjustments=vector(matrix.bankAdjustments||matrix.bank_adjustments||sumItems(bankItems));
  const bookAdjustments=vector(matrix.bookAdjustments||matrix.book_adjustments||sumItems(bookItems));
  const bankAdjusted=vector(matrix.bankAdjusted||matrix.bank_adjusted||add(bankBase,bankAdjustments));
  const bookAdjusted=vector(matrix.bookAdjusted||matrix.book_adjusted||add(bookBase,bookAdjustments));
  const differences=vector(matrix.differences||matrix.difference||subtract(bankAdjusted,bookAdjusted));
  const calculatedBalanced=Object.values(differences).every(value=>Math.abs(value)<.005);
  return{bankBase,bookBase,bankAdjustments,bookAdjustments,bankAdjusted,bookAdjusted,differences,balanced:Boolean(pick(matrix,'balanced','isBalanced','is_balanced')??calculatedBalanced),bankItems,bookItems};
}

function setYears(){
  const current=new Date().getFullYear(),years=rows(state.options,'years','periodYears','period_years').map(Number).filter(Number.isFinite);
  if(!years.length)for(let year=current-4;year<=current+2;year++)years.push(year);
  $('periodYear').innerHTML=[...new Set(years)].sort((a,b)=>b-a).map(year=>`<option value="${year}">${year}</option>`).join('');
  $('periodYear').value=String(current);
  $('periodMonth').innerHTML=MONTHS.map((month,index)=>`<option value="${index+1}">${month[0].toUpperCase()+month.slice(1)}</option>`).join('');
  $('periodMonth').value=String(new Date().getMonth()+1);
}
function renderOptions(){
  const subsidiary=state.options.subsidiary||state.options.activeSubsidiary||state.options.active_subsidiary||{};
  $('subsidiary').value=String(pick(subsidiary,'name','legalName','legal_name')||pick(state.options,'subsidiaryName','subsidiary_name')||'Empresa activa');
  $('bankAccount').innerHTML='<option value="">Seleccione una cuenta</option>'+bankAccounts().map(item=>{
    const id=pick(item,'id','bankAccountId','bank_account_id'),bank=pick(item,'bankName','bank_name','bank','financialInstitution','financial_institution')||'',account=pick(item,'accountNumber','account_number','number','name')||`Cuenta ${id}`,currency=pick(item,'currencyCode','currency_code','currency')||'';
    return`<option value="${esc(id)}">${esc([bank,account,currency].filter(Boolean).join(' · '))}</option>`;
  }).join('');
  state.history=rows(state.options,'reconciliations','history','periods');
  renderHistory();
}

function resetDraft({keepSelection=true}={}){
  state.detail=null;state.currentId=null;state.selectedStatementId=null;state.selectedBookId=null;
  for(const id of['bankStartBalance','bankTotalReceipts','bankTotalDisbursements','bankEndBalance'])$(id).value='0,00';
  $('workspace').hidden=keepSelection?!$('bankAccount').value:true;$('emptyState').hidden=!$('workspace').hidden;
  $('statusBadge').textContent='Sin guardar';$('statusBadge').className='status-badge draft';$('currencyBadge').textContent=currencySymbol()||'—';
  renderBankIdentity();renderAll();
}
function hydrateInputs(){
  const header=headerData();
  const map={bankStartBalance:['bankStartBalance','bank_start_balance'],bankTotalReceipts:['bankTotalReceipts','bank_total_receipts'],bankTotalDisbursements:['bankTotalDisbursements','bank_total_disbursements'],bankEndBalance:['bankEndBalance','bank_end_balance']};
  for(const[id,keys]of Object.entries(map))$(id).value=editMoney(pick(header,...keys));
  const accountId=pick(header,'bankAccountId','bank_account_id');if(accountId!==null)$('bankAccount').value=String(accountId);
  const year=pick(header,'periodYear','period_year'),month=pick(header,'periodMonth','period_month');if(year)$('periodYear').value=String(year);if(month)$('periodMonth').value=String(month);
}
function renderStatus(){
  const current=status(),labels={draft:'Borrador',in_review:'En revisión',approved:'Aprobada',closed:'Cerrada'};
  $('statusBadge').textContent=labels[current]||current;$('statusBadge').className=`status-badge ${current}`;$('currencyBadge').textContent=currencySymbol()||'—';
}
function renderBankIdentity(){
  const start=parseMoney($('bankStartBalance').value),receipts=parseMoney($('bankTotalReceipts').value),disbursements=parseMoney($('bankTotalDisbursements').value),end=parseMoney($('bankEndBalance').value),difference=start+receipts-disbursements-end,valid=Math.abs(difference)<.005;
  $('bankIdentity').className=`identity-check ${valid?'good':'bad'}`;
  $('bankIdentity').textContent=valid?'Identidad del extracto validada: saldo inicial + ingresos − egresos = saldo final.':`El extracto no conserva su identidad; diferencia ${money(difference)}.`;
  return valid;
}
function matrixRow(label,vectors,className=''){return`<tr class="${className}"><td>${esc(label)}</td><td>${money(vectors.start)}</td><td>${money(vectors.receipts)}</td><td>${money(vectors.disbursements)}</td><td>${money(vectors.end)}</td></tr>`;}
function renderMatrix(){
  const matrix=normalizedMatrix(),itemRow=(item,side)=>matrixRow(`↳ ${ITEM_LABELS[String(pick(item,'itemType','item_type')).toUpperCase()]||pick(item,'description')||'Partida'} · ${pick(item,'referenceNumber','reference_number')||dateLabel(pick(item,'transactionDate','transaction_date'))}`,impact(item),`adjustment ${side}-adjustment`);
  $('matrixRows').innerHTML=[matrixRow('Saldos según extracto bancario',matrix.bankBase,'section'),...matrix.bankItems.map(item=>itemRow(item,'bank')),matrixRow('SALDO BANCARIO AJUSTADO',matrix.bankAdjusted,'total'),matrixRow('Saldos según libros (GENTIA ERP)',matrix.bookBase,'section'),...matrix.bookItems.map(item=>itemRow(item,'book')),matrixRow('SALDO EN LIBROS AJUSTADO',matrix.bookAdjusted,'total'),matrixRow('DIFERENCIA BANCO − LIBROS',matrix.differences,`difference${matrix.balanced?' good':''}`)].join('');
  const pairs=[['Start','start'],['Receipts','receipts'],['Disbursements','disbursements'],['End','end']];
  for(const[id,key]of pairs){const element=$(`difference${id}`),card=element.closest('article'),value=matrix.differences[key],ok=Math.abs(value)<.005;element.textContent=money(value);card.classList.toggle('good',ok);card.classList.toggle('bad',!ok);}
  $('balanceState').className=`overall ${matrix.balanced?'good':'bad'}`;$('balanceState').innerHTML=matrix.balanced?'<small>Cuadre obligatorio</small><strong>Cuatro columnas en cero</strong><span>La conciliación puede aprobarse.</span>':'<small>Cuadre obligatorio</small><strong>Conciliación pendiente</strong><span>Corrija todas las diferencias antes de aprobar.</span>';
}
function renderContinuity(){
  const continuity=state.detail?.continuity||state.detail?.matrix?.continuity||{},notice=$('continuityNotice'),hasPrevious=Boolean(pick(continuity,'required','hasPrevious','has_previous','previousReconciliationId','previous_reconciliation_id','previousId','previous_id'));
  if(!hasPrevious&&!pick(continuity,'message')){notice.hidden=true;return;}
  const previous=pick(continuity,'expectedStartBalance','expected_start_balance','previousAdjustedEnd','previous_adjusted_end','previousEnd','previous_end'),current=pick(continuity,'actualStartBalance','actual_start_balance','currentAdjustedStart','current_adjusted_start','currentStart','current_start'),valid=Boolean(pick(continuity,'ok','valid','isValid','is_valid')??Math.abs(number(previous)-number(current))<.005);
  notice.hidden=false;notice.className=`continuity-notice${valid?'':' warning'}`;notice.textContent=String(pick(continuity,'message')||(valid?`Continuidad validada: el saldo final ajustado anterior (${money(previous)}) coincide con el saldo inicial de este período.`:`Continuidad pendiente: saldo final ajustado anterior ${money(previous)} vs. saldo inicial actual ${money(current)}.`));
}
function renderWorkflow(){
  const current=status(),balanced=normalizedMatrix().balanced,closed=current==='closed';
  $('sendReview').hidden=current!=='draft';$('sendReview').disabled=!state.currentId||closed||!canManage();
  $('approve').hidden=current!=='in_review';$('approve').disabled=!state.currentId||!balanced||!canApprove();
  $('closeReconciliation').hidden=current!=='approved';$('closeReconciliation').disabled=!state.currentId||!balanced||!canApprove();
  $('saveDraft').disabled=closed||!canManage();$('newItem').disabled=closed||!canManage();$('autoMatch').disabled=closed||!state.currentId||!canManage();$('newReconciliation').disabled=!canManage();
  for(const id of['bankStartBalance','bankTotalReceipts','bankTotalDisbursements','bankEndBalance'])$(id).disabled=closed||!canManage();
  $('downloadPdf').disabled=!state.currentId;$('downloadExcel').disabled=!state.currentId;
}
function renderItems(){
  const closed=isClosed()||!canManage(),items=reconciliationItems();
  $('itemRows').innerHTML=items.map(item=>{
    const id=pick(item,'id','itemId','item_id'),type=String(pick(item,'itemType','item_type')).toUpperCase(),v=impact(item),reference=pick(item,'referenceNumber','reference_number')||'Sin referencia',description=pick(item,'description')||'';
    return`<tr><td><span class="type-label">${esc(ITEM_LABELS[type]||type)}</span></td><td>${esc(dateLabel(pick(item,'transactionDate','transaction_date')))}</td><td><b>${esc(reference)}</b><br><small>${esc(description)}</small></td><td>${money(v.start)}</td><td>${money(v.receipts)}</td><td>${money(v.disbursements)}</td><td>${money(v.end)}</td><td>${closed?'—':`<button class="button secondary" type="button" data-edit-item="${esc(id)}">Editar</button> <button class="button danger" type="button" data-delete-item="${esc(id)}">Eliminar</button>`}</td></tr>`;
  }).join('')||'<tr><td colspan="8" class="empty-cell">No se han registrado partidas de conciliación.</td></tr>';
}
function statementLines(){return rows(state.detail,'statementLines','statement_lines','bankStatementLines','bank_statement_lines');}
function bookTransactions(){return rows(state.detail,'bookTransactions','book_transactions','transactions','bankTransactions','bank_transactions');}
function movementAmount(item){const direct=pick(item,'amount','transactionAmount','transaction_amount','signedAmount','signed_amount');if(direct!==null)return number(direct);return number(pick(item,'credit','receipt','entry'))-number(pick(item,'debit','disbursement','exit'));}
function renderMatchList(items,source){
  if(!items.length)return'<div class="empty-match">No hay movimientos pendientes para este período.</div>';
  return items.map(item=>{
    const id=pick(item,'id',source==='statement'?'statementLineId':'transactionId',source==='statement'?'statement_line_id':'transaction_id',source==='book'?'bankTransactionId':'none',source==='book'?'bank_transaction_id':'none'),matchId=pick(item,'matchId','match_id'),matched=Boolean(matchId||pick(item,'matched','isMatched','is_matched')),reference=pick(item,'reference','referenceNumber','reference_number','bankReference','bank_reference')||'Sin referencia',description=pick(item,'description','concept','note','beneficiary')||'',date=pick(item,'date','transactionDate','transaction_date','valueDate','value_date');
    return`<label class="match-row${matched?' matched':''}"><input type="radio" name="${source}Movement" value="${esc(id)}" ${matched||isClosed()?'disabled':''}><span>${esc(dateLabel(date))}<small>${matched?'Conciliado':'Pendiente'}</small></span><span>${esc(reference)}<small>${esc(description)}</small></span><b>${money(movementAmount(item))}${matchId&&!isClosed()?`<small><button type="button" class="unlink-match" data-match-id="${esc(matchId)}">Desconciliar</button></small>`:''}</b></label>`;
  }).join('');
}
function renderMatching(){
  const statements=statementLines(),books=bookTransactions(),matches=rows(state.detail,'matches','reconciliationMatches','reconciliation_matches'),statementPending=statements.filter(item=>!pick(item,'matchId','match_id','matched','isMatched','is_matched')).length,bookPending=books.filter(item=>!pick(item,'matchId','match_id','matched','isMatched','is_matched')).length;
  $('statementLines').innerHTML=renderMatchList(statements,'statement');$('bookTransactions').innerHTML=renderMatchList(books,'book');
  $('statementCount').textContent=`${statementPending} pendiente${statementPending===1?'':'s'} en extracto`;$('bookCount').textContent=`${bookPending} pendiente${bookPending===1?'':'s'} en libros`;$('matchedCount').textContent=`${matches.length} conciliado${matches.length===1?'':'s'}`;
  $('manualMatch').disabled=isClosed()||!canManage()||!state.selectedStatementId||!state.selectedBookId;
}
function renderHistory(){
  const accountId=$('bankAccount')?.value,history=(state.history||[]).filter(row=>!accountId||String(pick(row,'bankAccountId','bank_account_id'))===String(accountId));
  $('historyRows').innerHTML=history.map(row=>{
    const id=reconciliationId(row),year=pick(row,'periodYear','period_year'),month=number(pick(row,'periodMonth','period_month')),rowStatus=String(pick(row,'status')||'draft').toLowerCase(),account=pick(row,'bankAccountName','bank_account_name','accountNumber','account_number')||`Cuenta ${pick(row,'bankAccountId','bank_account_id')||''}`,prepared=pick(row,'reconciledByName','reconciled_by_name','preparedBy','prepared_by')||'—',approved=pick(row,'approvedByName','approved_by_name')||'—',updated=pick(row,'updatedAt','updated_at');
    return`<tr><td>${esc(MONTHS[month-1]||month)} ${esc(year||'')}</td><td>${esc(account)}</td><td><span class="status-badge ${esc(rowStatus)}">${esc({draft:'Borrador',in_review:'En revisión',approved:'Aprobada',closed:'Cerrada'}[rowStatus]||rowStatus)}</span></td><td>${esc(prepared)}</td><td>${esc(approved)}</td><td>${esc(dateLabel(updated))}</td><td><button class="button secondary" type="button" data-open-reconciliation="${esc(id)}">Abrir</button></td></tr>`;
  }).join('')||'<tr><td colspan="7" class="empty-cell">No existen conciliaciones para esta cuenta.</td></tr>';
}
function renderAll(){if(!state.detail){renderMatrix();renderItems();renderMatching();renderWorkflow();return;}renderStatus();renderBankIdentity();renderMatrix();renderContinuity();renderWorkflow();renderItems();renderMatching();renderHistory();}

async function loadOptions(){
  setBusy(true);setMessage();
  try{state.options=unwrap(await api(`${BASE}/options`));setYears();renderOptions();const preferred=bankAccounts()[0];if(preferred)$('bankAccount').value=String(pick(preferred,'id','bankAccountId','bank_account_id'));resetDraft();}
  catch(error){setMessage(errorMessage(error),'error');$('emptyState').querySelector('p').textContent='No fue posible cargar las cuentas bancarias autorizadas.';}
  finally{setBusy(false);}
}
async function loadDetail(id,{announce=false}={}){
  if(!id)return;
  setBusy(true);setMessage();
  try{
    const [detailResult,matrixResult]=await Promise.allSettled([api(`${BASE}/${encodeURIComponent(id)}`),api(`${BASE}/${encodeURIComponent(id)}/matrix`)]),detail=detailResult.status==='fulfilled'?unwrap(detailResult.value):null,matrix=matrixResult.status==='fulfilled'?unwrap(matrixResult.value):null;
    if(!detail)throw detailResult.reason;
    state.currentId=id;state.detail={...detail,...(matrix&&matrix!==detail?{matrix:matrix.matrix||matrix,continuity:matrix.continuity||detail.continuity}:{}),items:rows(detail,'items','reconciliationItems','reconciliation_items'),statementLines:rows(detail,'statementLines','statement_lines','bankStatementLines','bank_statement_lines'),bookTransactions:rows(detail,'bookTransactions','book_transactions','transactions','bankTransactions','bank_transactions'),matches:rows(detail,'matches','reconciliationMatches','reconciliation_matches')};
    $('workspace').hidden=false;$('emptyState').hidden=true;hydrateInputs();renderAll();if(announce)setMessage('Conciliación cargada correctamente.');
  }catch(error){setMessage(errorMessage(error),'error');}
  finally{setBusy(false);}
}
async function openPeriod(){
  const bankAccountId=$('bankAccount').value,periodYear=$('periodYear').value,periodMonth=$('periodMonth').value;if(!bankAccountId){setMessage('Seleccione una cuenta bancaria.','error');return;}
  setBusy(true);setMessage();
  try{
    const query=new URLSearchParams({bankAccountId,periodYear,periodMonth}),response=unwrap(await api(`${BASE}?${query}`)),list=rows(response,'reconciliations','rows','items'),existing=list.find(row=>String(pick(row,'periodYear','period_year'))===periodYear&&String(pick(row,'periodMonth','period_month'))===periodMonth)||state.history.find(row=>String(pick(row,'bankAccountId','bank_account_id'))===bankAccountId&&String(pick(row,'periodYear','period_year'))===periodYear&&String(pick(row,'periodMonth','period_month'))===periodMonth);
    if(existing){setBusy(false);await loadDetail(reconciliationId(existing),{announce:true});return;}
    resetDraft();$('workspace').hidden=false;$('emptyState').hidden=true;renderAll();setMessage(`Nuevo borrador para ${MONTHS[Number(periodMonth)-1]} de ${periodYear}. Ingrese los cuatro valores del extracto y guarde.`);
  }catch(error){resetDraft();$('workspace').hidden=false;$('emptyState').hidden=true;setMessage(errorMessage(error),'error');}
  finally{setBusy(false);}
}
function draftPayload(){return{id:state.currentId||undefined,reconciliationId:state.currentId||undefined,bankAccountId:Number($('bankAccount').value),periodYear:Number($('periodYear').value),periodMonth:Number($('periodMonth').value),bankStartBalance:parseMoney($('bankStartBalance').value),bankTotalReceipts:parseMoney($('bankTotalReceipts').value),bankTotalDisbursements:parseMoney($('bankTotalDisbursements').value),bankEndBalance:parseMoney($('bankEndBalance').value)};}
async function saveDraft(){
  if(!$('bankAccount').value){setMessage('Seleccione una cuenta bancaria.','error');return;}if(!renderBankIdentity()){setMessage('Los valores del extracto no cumplen saldo inicial + ingresos − egresos = saldo final.','error');return;}
  setBusy(true);setMessage();
  try{const saved=unwrap(await api(BASE,{method:'POST',body:JSON.stringify(draftPayload())})),id=reconciliationId(saved)||reconciliationId(saved.header)||state.currentId;if(!id)throw Error('El servidor guardó el borrador, pero no devolvió su identificador.');setBusy(false);await loadOptionsAfterSave(id);setMessage('Borrador guardado y valores de libros recalculados.');}
  catch(error){setMessage(errorMessage(error),'error');}
  finally{setBusy(false);}
}
async function loadOptionsAfterSave(id){const selected={account:$('bankAccount').value,year:$('periodYear').value,month:$('periodMonth').value};try{state.options=unwrap(await api(`${BASE}/options`));state.history=rows(state.options,'reconciliations','history','periods');renderHistory();}catch{}$('bankAccount').value=selected.account;$('periodYear').value=selected.year;$('periodMonth').value=selected.month;await loadDetail(id);}

function suggestedImpact(type,amount){
  const a=Math.abs(number(amount));
  return({
    DEPOSIT_IN_TRANSIT_CURRENT:[0,a,0,a],DEPOSIT_IN_TRANSIT_PRIOR:[a,-a,0,0],OUTSTANDING_CHECK_CURRENT:[0,0,a,-a],OUTSTANDING_CHECK_PRIOR:[-a,0,-a,0],UNRECORDED_BANK_CHARGE:[0,0,a,-a],UNRECORDED_BANK_CREDIT:[0,a,0,a]
  })[type]||[0,0,0,0];
}
function applySuggestedImpact(){const type=$('itemType').value,values=suggestedImpact(type,parseMoney($('itemAmount').value));if(!['BOOK_ERROR','BANK_ERROR'].includes(type))['impactStart','impactReceipts','impactDisbursements','impactEnd'].forEach((id,index)=>$(id).value=editMoney(values[index]));$('impactHelp').textContent=['BOOK_ERROR','BANK_ERROR'].includes(type)?'Ingrese el impacto firmado. Debe cumplirse: saldo inicial + ingresos − egresos = saldo final.':'Impacto estándar aplicado automáticamente según el tipo de partida.';}
function openItemDialog(item=null){
  $('itemForm').reset();$('itemId').value=item?String(pick(item,'id','itemId','item_id')):'';$('itemTransactionId').value=item?String(pick(item,'transactionId','transaction_id')||''):'';$('itemDialogTitle').textContent=item?'Editar partida':'Nueva partida';$('itemType').value=item?String(pick(item,'itemType','item_type')):'DEPOSIT_IN_TRANSIT_CURRENT';$('itemDate').value=String(pick(item,'transactionDate','transaction_date')||new Date().toISOString().slice(0,10));$('itemReference').value=String(pick(item,'referenceNumber','reference_number')||'');$('itemDescription').value=String(pick(item,'description')||'');
  const v=item?impact(item):null,amount=item?Math.max(...Object.values(v).map(Math.abs)):0;$('itemAmount').value=editMoney(amount);if(v)['impactStart','impactReceipts','impactDisbursements','impactEnd'].forEach((id,index)=>$(id).value=editMoney([v.start,v.receipts,v.disbursements,v.end][index]));else applySuggestedImpact();$('itemError').textContent='';$('itemDialog').showModal();
}
async function saveItem(event){
  event.preventDefault();const impacts={impactStartBalance:parseMoney($('impactStart').value),impactReceipts:parseMoney($('impactReceipts').value),impactDisbursements:parseMoney($('impactDisbursements').value),impactEndBalance:parseMoney($('impactEnd').value)},identity=impacts.impactStartBalance+impacts.impactReceipts-impacts.impactDisbursements-impacts.impactEndBalance;
  if(Math.abs(identity)>=.005){$('itemError').textContent=`La partida no conserva la identidad de cuatro columnas. Diferencia: ${money(identity)}.`;return;}
  const payload={id:$('itemId').value?Number($('itemId').value):undefined,itemId:$('itemId').value?Number($('itemId').value):undefined,transactionId:$('itemTransactionId').value?Number($('itemTransactionId').value):null,itemType:$('itemType').value,description:$('itemDescription').value.trim(),referenceNumber:$('itemReference').value.trim()||null,transactionDate:$('itemDate').value,amount:parseMoney($('itemAmount').value),...impacts};
  if(!payload.description){$('itemError').textContent='Ingrese una descripción para la partida.';return;}
  setBusy(true);try{await api(`${BASE}/${state.currentId}/items`,{method:'POST',body:JSON.stringify(payload)});$('itemDialog').close();setBusy(false);await loadDetail(state.currentId);setMessage('Partida de conciliación guardada.');}catch(error){$('itemError').textContent=errorMessage(error);}finally{setBusy(false);}
}
function confirmAction(title,text,button='Confirmar'){return new Promise(resolve=>{const dialog=$('confirmDialog'),action=$('confirmAction');$('confirmTitle').textContent=title;$('confirmText').textContent=text;action.textContent=button;const onClose=()=>{dialog.removeEventListener('close',onClose);resolve(dialog.returnValue==='confirm');};dialog.addEventListener('close',onClose);dialog.showModal();});}
async function deleteItem(id){if(!await confirmAction('Eliminar partida','La partida se retirará de la matriz y se recalcularán las cuatro diferencias.','Eliminar'))return;setBusy(true);try{await api(`${BASE}/${state.currentId}/items/${encodeURIComponent(id)}`,{method:'DELETE'});setBusy(false);await loadDetail(state.currentId);setMessage('Partida eliminada.');}catch(error){setMessage(errorMessage(error),'error');}finally{setBusy(false);}}

async function autoMatch(){setBusy(true);setMessage();try{const result=unwrap(await api(`${BASE}/${state.currentId}/auto-match`,{method:'POST',body:JSON.stringify({toleranceDays:Number($('toleranceDays').value)||0})})),count=number(pick(result,'matched','matchedCount','matched_count','count'));setBusy(false);await loadDetail(state.currentId);setMessage(`${count} movimiento${count===1?'':'s'} conciliado${count===1?'':'s'} automáticamente.`);}catch(error){setMessage(errorMessage(error),'error');}finally{setBusy(false);}}
async function manualMatch(){if(!state.selectedStatementId||!state.selectedBookId)return;setBusy(true);try{await api(`${BASE}/${state.currentId}/matches`,{method:'POST',body:JSON.stringify({statementLineId:Number(state.selectedStatementId),bookTransactionId:Number(state.selectedBookId)})});state.selectedStatementId=null;state.selectedBookId=null;setBusy(false);await loadDetail(state.currentId);setMessage('Movimientos conciliados manualmente.');}catch(error){setMessage(errorMessage(error),'error');}finally{setBusy(false);}}
async function unmatch(matchId){if(!await confirmAction('Desconciliar movimientos','Los movimientos volverán a quedar disponibles para el punteo.','Desconciliar'))return;setBusy(true);try{await api(`${BASE}/${state.currentId}/matches/${encodeURIComponent(matchId)}`,{method:'DELETE'});setBusy(false);await loadDetail(state.currentId);setMessage('Los movimientos se marcaron como pendientes.');}catch(error){setMessage(errorMessage(error),'error');}finally{setBusy(false);}}
async function transition(target){
  const titles={in_review:'Enviar a revisión',approved:'Aprobar conciliación',closed:'Cerrar período'},texts={in_review:'El borrador quedará disponible para revisión y aprobación.',approved:'Se validarán nuevamente las cuatro diferencias antes de aprobar.',closed:'El período y sus partidas quedarán bloqueados contra modificaciones.'};
  if(!await confirmAction(titles[target],texts[target],titles[target]))return;setBusy(true);setMessage();
  try{const endpoint=target==='approved'?'approve':target==='closed'?'close':'transition',body=target==='in_review'?{status:'in_review',targetStatus:'in_review'}:{};await api(`${BASE}/${state.currentId}/${endpoint}`,{method:'POST',body:JSON.stringify(body)});setBusy(false);await loadDetail(state.currentId);setMessage(target==='closed'?'Período cerrado. La conciliación quedó inmutable.':target==='approved'?'Conciliación aprobada.':'Conciliación enviada a revisión.');}
  catch(error){setMessage(errorMessage(error),'error');}finally{setBusy(false);}
}
async function downloadFile(format){
  if(!state.currentId)return;setBusy(true);setMessage();
  try{
    const response=await fetch(`${BASE}/${state.currentId}/${format}`,{headers:{Authorization:`Bearer ${token()}`,'X-Device-Token':device()}});if(!response.ok){const raw=await response.text();let payload;try{payload=JSON.parse(raw)}catch{}throw Error(payload?.error?.message||payload?.message||'No fue posible generar el archivo.');}
    const type=response.headers.get('content-type')||'',disposition=response.headers.get('content-disposition')||'';let blob,fileName;
    if(type.includes('application/json')){const payload=unwrap(await response.json());if(!payload.base64)throw Error('El servidor no devolvió el contenido del archivo.');const binary=atob(payload.base64),bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);blob=new Blob([bytes],{type:payload.mimeType||payload.mime_type||'application/octet-stream'});fileName=payload.fileName||payload.file_name;}
    else blob=await response.blob();
    fileName=fileName||decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]||disposition.match(/filename="?([^";]+)"?/i)?.[1]||`prueba-efectivo-${$('periodYear').value}-${String($('periodMonth').value).padStart(2,'0')}.${format==='xlsx'?'xlsx':'pdf'}`);
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=fileName;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);setMessage(`${format==='pdf'?'PDF':'Excel'} descargado correctamente.`);
  }catch(error){setMessage(errorMessage(error),'error');}finally{setBusy(false);}
}

function wireEvents(){
  $('openPeriod').addEventListener('click',openPeriod);$('saveDraft').addEventListener('click',saveDraft);$('newReconciliation').addEventListener('click',()=>{resetDraft();$('workspace').hidden=!$('bankAccount').value;$('emptyState').hidden=!$('workspace').hidden;setMessage('Ingrese los valores del extracto para preparar un nuevo borrador.');});
  $('bankAccount').addEventListener('change',()=>{resetDraft();renderHistory();});for(const id of['bankStartBalance','bankTotalReceipts','bankTotalDisbursements','bankEndBalance'])$(id).addEventListener('input',renderBankIdentity);
  document.querySelectorAll('.workspace-tabs button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.workspace-tabs button').forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-selected',String(item===button));});for(const panel of['matrix','matching','items','history'])$(`${panel}Panel`).hidden=panel!==button.dataset.panel;}));
  $('newItem').addEventListener('click',()=>openItemDialog());$('closeItemDialog').addEventListener('click',()=>$('itemDialog').close());$('cancelItem').addEventListener('click',()=>$('itemDialog').close());$('itemForm').addEventListener('submit',saveItem);$('itemType').addEventListener('change',applySuggestedImpact);$('itemAmount').addEventListener('input',applySuggestedImpact);
  $('itemRows').addEventListener('click',event=>{const edit=event.target.closest('[data-edit-item]'),remove=event.target.closest('[data-delete-item]');if(edit){const item=reconciliationItems().find(row=>String(pick(row,'id','itemId','item_id'))===edit.dataset.editItem);if(item)openItemDialog(item);}if(remove)void deleteItem(remove.dataset.deleteItem);});
  $('autoMatch').addEventListener('click',autoMatch);$('manualMatch').addEventListener('click',manualMatch);$('matchingPanel').addEventListener('change',event=>{if(event.target.name==='statementMovement')state.selectedStatementId=event.target.value;if(event.target.name==='bookMovement')state.selectedBookId=event.target.value;$('manualMatch').disabled=!state.selectedStatementId||!state.selectedBookId;});$('matchingPanel').addEventListener('click',event=>{const button=event.target.closest('[data-match-id]');if(button){event.preventDefault();void unmatch(button.dataset.matchId);}});
  $('historyRows').addEventListener('click',event=>{const button=event.target.closest('[data-open-reconciliation]');if(button)void loadDetail(button.dataset.openReconciliation);});$('sendReview').addEventListener('click',()=>transition('in_review'));$('approve').addEventListener('click',()=>transition('approved'));$('closeReconciliation').addEventListener('click',()=>transition('closed'));$('downloadPdf').addEventListener('click',()=>downloadFile('pdf'));$('downloadExcel').addEventListener('click',()=>downloadFile('xlsx'));
}

wireEvents();
loadOptions();
