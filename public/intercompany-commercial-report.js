const $=id=>document.getElementById(id);
const token=()=>localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const device=()=>localStorage.getItem('nexo_device_token')||'';
const state={options:{},report:null,loading:false,dirty:false,lastFilterSignature:''};

if(!token())location.assign('/');

const array=value=>Array.isArray(value)?value:[];
const first=(...values)=>values.find(value=>value!==undefined&&value!==null&&value!=='');
const number=value=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:0};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt=value=>number(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const integer=value=>number(value).toLocaleString('es-CR',{maximumFractionDigits:0});
const optionArray=(source,...keys)=>{for(const key of keys)if(Array.isArray(source?.[key]))return source[key];return[]};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const date=value=>{if(!value)return'—';const parsed=new Date(`${String(value).slice(0,10)}T12:00:00`);return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleDateString('es-CR',{day:'2-digit',month:'short',year:'numeric'})};
const normalizePartyType=value=>{const type=String(value||'').toUpperCase();return /SUPPLIER|VENDOR|PROVEEDOR/.test(type)?'SUPPLIER':/CUSTOMER|CLIENT|CLIENTE/.test(type)?'CUSTOMER':''};
const partyMatchesDirection=(item,direction)=>direction==='ALL'||(direction==='RECEIVABLE'&&normalizePartyType(first(item?.thirdPartyType,item?.third_party_type,item?.type,item?.entityType,item?.entity_type))==='CUSTOMER')||(direction==='PAYABLE'&&normalizePartyType(first(item?.thirdPartyType,item?.third_party_type,item?.type,item?.entityType,item?.entity_type))==='SUPPLIER');

function authHeaders(body=false){return{Authorization:`Bearer ${token()}`,'X-Device-Token':device(),...(body?{'Content-Type':'application/json'}:{})}}
async function api(path,init={}){
  const response=await fetch(path,{...init,headers:{...authHeaders(Boolean(init.body)),...(init.headers||{})}});
  const raw=await response.text();let payload=null;try{payload=raw?JSON.parse(raw):null}catch{payload=raw}
  if(!response.ok)throw Error(payload?.error?.message||payload?.message||'No fue posible completar la operación.');
  return payload;
}

function idOf(item){return first(item?.id,item?.subsidiaryId,item?.subsidiary_id,item?.accountingBookId,item?.accounting_book_id,item?.thirdPartyId,item?.third_party_id,item?.currencyId,item?.currency_id)}
function subsidiaryIdOf(item){return first(item?.subsidiaryId,item?.subsidiary_id,item?.id)}
function labelOf(item){return first(item?.displayName,item?.name,item?.companyName,item?.bookName,item?.currencyName,item?.code,item?.id,'')}
function fill(id,items,placeholder,label=labelOf,value=idOf){
  const element=$(id),previous=element.value;element.replaceChildren();if(placeholder!==null)element.append(new Option(placeholder,''));
  for(const item of items){const optionValue=value(item);if(optionValue===undefined||optionValue===null||optionValue==='')continue;element.append(new Option(label(item),String(optionValue)))}
  if([...element.options].some(option=>option.value===previous))element.value=previous;
}
function subsidiaryOptions(){const list=optionArray(state.options,'subsidiaries','companies');if(list.length)return list;const single=state.options.subsidiary||state.options.activeSubsidiary;return single?[single]:[]}
function subsidiaryLinks(item){return array(first(item?.subsidiaryIds,item?.subsidiary_ids,item?.subsidiaries)).map(value=>String(typeof value==='object'?subsidiaryIdOf(value):value))}
function belongs(item,sid){const direct=first(item?.subsidiaryId,item?.subsidiary_id),links=subsidiaryLinks(item);return direct!==undefined&&direct!==null?String(direct)===String(sid):!links.length||links.includes(String(sid))}
function populateDependentOptions(){
  const sid=$('subsidiary').value;
  const intercompanyBooks=optionArray(state.options,'intercompanyBooks','intercompany_books'),books=intercompanyBooks.length?intercompanyBooks:optionArray(state.options,'books','accountingBooks','accounting_books');
  fill('book',books.filter(item=>belongs(item,sid)),'Libro principal',item=>first(item.name,item.bookName,item.book_name,'Libro'));
  const direction=$('direction').value||'ALL';
  const parties=optionArray(state.options,'intercompanyCommercialParties','intercompany_commercial_parties','thirdParties','third_parties','commercialParties','commercial_parties','entities').filter(item=>belongs(item,sid)&&partyMatchesDirection(item,direction));
  fill('thirdParty',parties,'Todos los terceros',item=>{const type=normalizePartyType(first(item.thirdPartyType,item.third_party_type,item.type,item.entityType,item.entity_type));return`${type==='SUPPLIER'?'Proveedor':'Cliente'} · ${[first(item.code,item.number,item.entityNumber,item.entity_number),first(item.name,item.displayName,item.legalName,item.legal_name)].filter(Boolean).join(' · ')}`},item=>first(item.partyKey,item.party_key,`${normalizePartyType(first(item.thirdPartyType,item.third_party_type,item.type,item.entityType,item.entity_type))}:${idOf(item)}`));
  fill('currency',optionArray(state.options,'currencies'),'Todas las monedas',item=>[first(item.code,item.currencyCode,item.currency_code),first(item.name,item.currencyName,item.currency_name)].filter(Boolean).join(' · '));
}

function setDefaultDates(){const now=new Date(),local=new Date(now.getTime()-now.getTimezoneOffset()*60000),today=local.toISOString().slice(0,10);$('dateFrom').value=`${today.slice(0,4)}-01-01`;$('dateTo').value=today}
function filters(){const sid=Number($('subsidiary').value),currency=$('currency').value;return{subsidiaryIds:[sid],bookId:$('book').value||null,dateFrom:$('dateFrom').value,dateTo:$('dateTo').value,partyKey:$('thirdParty').value||null,currencyIds:currency?[Number(currency)]:[],direction:$('direction').value||'ALL',onlyPending:$('onlyPending').checked,search:$('search').value.trim()||null}}
function validateFilters(){const sid=filters().subsidiaryIds[0];if(!Number.isSafeInteger(sid)||sid<=0)throw Error('Seleccione una subsidiaria válida.');if(!$('dateFrom').value||!$('dateTo').value)throw Error('Indique el rango de fechas.');if($('dateFrom').value>$('dateTo').value)throw Error('La fecha inicial no puede ser posterior a la fecha final.')}
function setLoading(value){state.loading=value;document.body.classList.toggle('loading',value);for(const id of['generate','resetFilters','downloadCsv','downloadExcel','downloadPdf'])$(id).disabled=value||(['downloadCsv','downloadExcel','downloadPdf'].includes(id)&&(!state.report||state.dirty));$('generate').textContent=value?'Generando…':'Generar reporte'}
function message(text='',success=false){$('message').textContent=text;$('message').classList.toggle('success',success)}
function filterSignature(){return JSON.stringify(filters())}
function markDirty(){if(!state.report)return;state.dirty=filterSignature()!==state.lastFilterSignature;setLoading(false);if(state.dirty)message('Los filtros cambiaron. Genere nuevamente el reporte antes de descargar.',false)}
function canExport(){if(!state.report)return false;if(state.dirty||filterSignature()!==state.lastFilterSignature){markDirty();return false}return true}

function thirdPartyMeta(row,side=''){
  const nested=object(first(row?.thirdParty,row?.third_party,row?.customer,row?.client,row?.supplier,row?.vendor,row?.entity));
  const type=normalizePartyType(first(nested.thirdPartyType,nested.third_party_type,nested.partyType,nested.party_type,nested.type,row?.thirdPartyType,row?.third_party_type,row?.partyType,row?.party_type,row?.entityType,row?.entity_type,side==='PAYABLE'?'SUPPLIER':side==='RECEIVABLE'?'CUSTOMER':''));
  const fallback=type==='SUPPLIER'?'Sin proveedor':'Sin cliente';
  return{
    id:first(nested.id,nested.thirdPartyId,nested.third_party_id,nested.partyId,nested.party_id,row?.thirdPartyId,row?.third_party_id,row?.partyId,row?.party_id,row?.customerId,row?.customer_id,row?.supplierId,row?.supplier_id,row?.vendorId,row?.vendor_id),
    key:first(nested.partyKey,nested.party_key,nested.key,row?.partyKey,row?.party_key),type,
    code:first(nested.code,nested.number,nested.entityNumber,nested.entity_number,nested.partyCode,nested.party_code,row?.thirdPartyCode,row?.third_party_code,row?.partyCode,row?.party_code,row?.customerCode,row?.customer_code,row?.supplierCode,row?.supplier_code,''),
    name:first(nested.name,nested.displayName,nested.legalName,nested.legal_name,nested.partyName,nested.party_name,row?.thirdPartyName,row?.third_party_name,row?.partyName,row?.party_name,row?.customerName,row?.customer_name,row?.supplierName,row?.supplier_name,row?.vendorName,row?.vendor_name,fallback),
    identification:first(nested.identification,nested.taxId,nested.tax_id,row?.thirdPartyIdentification,row?.third_party_identification,row?.identification,row?.taxId,row?.tax_id,'')
  };
}
function currencyMeta(row){const nested=object(row?.currency);const id=first(nested.id,nested.currencyId,row?.currencyId,row?.currency_id);const catalog=optionArray(state.options,'currencies').find(item=>String(idOf(item))===String(id));return{id,code:first(nested.code,nested.currencyCode,row?.currencyCode,row?.currency_code,row?.currency,catalog?.code,catalog?.currencyCode,'MONEDA'),name:first(nested.name,nested.currencyName,row?.currencyName,row?.currency_name,catalog?.name,catalog?.currencyName,''),symbol:first(nested.symbol,row?.currencySymbol,row?.currency_symbol,catalog?.symbol,'')};}
function prefixedCurrencyMeta(row,prefix){const id=first(row?.[`${prefix}CurrencyId`],row?.[`${prefix}_currency_id`]),code=first(row?.[`${prefix}CurrencyCode`],row?.[`${prefix}_currency_code`]),catalog=optionArray(state.options,'currencies').find(item=>String(idOf(item))===String(id)||String(first(item.code,item.currencyCode,item.currency_code,''))===String(code));return{id,code:first(code,catalog?.code,catalog?.currencyCode,'MONEDA'),name:first(row?.[`${prefix}CurrencyName`],row?.[`${prefix}_currency_name`],catalog?.name,catalog?.currencyName,''),symbol:first(row?.[`${prefix}CurrencySymbol`],row?.[`${prefix}_currency_symbol`],catalog?.symbol,'')};}
function subsidiaryMeta(row){const id=first(row?.subsidiaryId,row?.subsidiary_id),catalog=subsidiaryOptions().find(item=>String(subsidiaryIdOf(item))===String(id));return{id,name:first(row?.subsidiaryName,row?.subsidiary_name,labelOf(catalog),'Subsidiaria')};}
function accountMeta(row){const nested=object(row?.account);return{id:first(nested.id,nested.accountId,row?.accountId,row?.account_id),number:first(nested.number,nested.code,nested.accountNumber,row?.accountNumber,row?.account_number,''),name:first(nested.name,nested.accountName,row?.accountName,row?.account_name,'')};}
function balanceRow(row,side){
  const party=thirdPartyMeta(row,side),currency=currencyMeta(row),account=accountMeta(row);
  return{
    raw:row,side,party,currency,account,
    opening:number(first(row.opening,row.openingBalance,row.opening_balance,row.initialBalance,row.initial_balance)),
    debit:number(first(row.debit,row.debits,row.periodDebits,row.period_debits)),
    credit:number(first(row.credit,row.credits,row.periodCredits,row.period_credits)),
    closing:number(first(row.closing,row.closingBalance,row.closing_balance,row.finalBalance,row.final_balance,row.outstandingBalance,row.outstanding_balance,row.balance)),
    documentBalance:number(first(row.documentBalance,row.document_balance,0)),
    openDocumentCount:number(first(row.openDocumentCount,row.open_document_count,0)),
    difference:number(first(row.difference,row.reconciliationDifference,row.reconciliation_difference,0))
  };
}
function reportArray(report,...keys){return optionArray(report,...keys)}
function normalizeReport(payload){
  const report=object(payload),groups=reportArray(report,'accountGroups','account_groups');
  const groupFor=side=>{
    const row=groups.find(item=>String(first(item.direction,item.side,'')).toUpperCase()===side)||{};
    return{id:first(row.id,row.groupId),number:first(row.code,row.groupCode,side==='PAYABLE'?'211002':'113002'),name:first(row.name,row.groupName,side==='PAYABLE'?'Cuentas por Pagar Proveedores Intercompany':'Cuentas por Cobrar Clientes Intercompany')};
  };
  const normalizeBalance=(row,side)=>{
    const normalized=balanceRow(row,side);
    if(!normalized.account.number&&!normalized.account.name)normalized.account=groupFor(side);
    return normalized;
  };
  const receivables=reportArray(report,'receivables','accountsReceivable','accounts_receivable').map(row=>normalizeBalance(row,'RECEIVABLE'));
  const payables=reportArray(report,'payables','accountsPayable','accounts_payable').map(row=>normalizeBalance(row,'PAYABLE'));
  const agingLabels={CURRENT:'Por vencer','1_30':'1 - 30 días','31_60':'31 - 60 días','61_90':'61 - 90 días','91_120':'91 - 120 días',OVER_120:'Más de 120 días'};
  const detailSource=reportArray(report,'documents','documentDetails','document_details','details','detail','movements','rows');
  const details=detailSource.map(row=>{
    const rawDirection=String(first(row.direction,row.side,row.balanceType,row.balance_type,row.type,'')).toUpperCase();
    const side=rawDirection.includes('PAY')||rawDirection.includes('PAGAR')||normalizePartyType(first(row.partyType,row.party_type,row.thirdPartyType,row.third_party_type))==='SUPPLIER'?'PAYABLE':'RECEIVABLE';
    const localCurrencyCode=first(row.localCurrencyCode,row.local_currency_code,''),localCatalog=optionArray(state.options,'currencies').find(item=>String(first(item.code,item.currencyCode,item.currency_code))===String(localCurrencyCode));
    const debit=number(first(row.originalDebit,row.original_debit,row.debit,row.debitAmount,row.debit_amount));
    const credit=number(first(row.originalCredit,row.original_credit,row.credit,row.creditAmount,row.credit_amount));
    const gross=number(first(row.originalAmount,row.original_amount,row.documentAmount,row.document_amount,row.grossAmount,row.gross_amount,row.amount,side==='PAYABLE'?credit:debit));
    const applied=number(first(row.appliedAmount,row.applied_amount,row.paidAmount,row.paid_amount,row.settledAmount,row.settled_amount,0));
    const creditNotes=number(first(row.creditAmount,row.credit_amount,row.creditNoteAmount,row.credit_note_amount,0));
    const debitNotes=number(first(row.debitAmount,row.debit_amount,row.debitNoteAmount,row.debit_note_amount,0));
    const outstanding=number(first(row.outstanding,row.outstandingBalance,row.outstanding_balance,row.openBalance,row.open_balance,row.balance,row.originalRunningBalance,row.original_running_balance,row.runningBalance,row.running_balance,gross-applied-creditNotes+debitNotes));
    const agingCode=String(first(row.agingBucket,row.aging_bucket,row.ageBucket,row.age_bucket,'—'));
    return{
      raw:row,side,party:thirdPartyMeta(row,side),currency:currencyMeta(row),account:accountMeta(row),
      date:first(row.date,row.postingDate,row.posting_date,row.issueDate,row.issue_date,row.transactionDate,row.transaction_date,row.documentDate,row.document_date),
      dueDate:first(row.dueDate,row.due_date,row.maturityDate,row.maturity_date),
      document:first(row.documentNumber,row.document_number,row.invoiceNumber,row.invoice_number,row.transactionNumber,row.transaction_number,row.document,'—'),
      journalNumber:first(row.journalNumber,row.journal_number,''),journalId:first(row.journalId,row.journal_id),
      concept:first(row.concept,row.memo,row.note,row.description,'—'),agingBucket:agingLabels[agingCode]||agingCode,
      gross,applied,creditNotes,debitNotes,outstanding,debit,credit,balance:outstanding,
      localCurrency:{code:localCurrencyCode,name:first(row.localCurrencyName,row.local_currency_name,localCatalog?.name,''),symbol:first(row.localCurrencySymbol,row.local_currency_symbol,localCatalog?.symbol,'')},
      localDebit:number(first(row.localDebit,row.local_debit,0)),localCredit:number(first(row.localCredit,row.local_credit,0)),localMovement:number(first(row.localMovement,row.local_movement,0)),
      isFxRevaluation:row.isFxRevaluation===true||row.is_fx_revaluation===true
    };
  });
  const localPositions=reportArray(report,'localPositions','local_positions').map(row=>{
    const side=String(first(row.direction,row.side,'')).toUpperCase()==='PAYABLE'?'PAYABLE':'RECEIVABLE';
    const receivable=number(first(row.receivableClosing,row.receivable_closing,side==='RECEIVABLE'?row.closingBalance:undefined,row.receivable,row.accountsReceivable,row.accounts_receivable));
    const payable=number(first(row.payableClosing,row.payable_closing,side==='PAYABLE'?row.closingBalance:undefined,row.payable,row.accountsPayable,row.accounts_payable));
    return{raw:row,subsidiary:subsidiaryMeta(row),party:thirdPartyMeta(row,side),originalCurrency:prefixedCurrencyMeta(row,'original'),localCurrency:prefixedCurrencyMeta(row,'local'),receivable,payable,net:number(first(row.netPosition,row.net_position,row.net,receivable-payable))};
  });
  const rawCurrencies=reportArray(report,'currencySummaries','currency_summaries','currencies','currencyBreakdown','currency_breakdown','totalsByCurrency','totals_by_currency');
  let currencies=rawCurrencies.map(row=>{
    const currency=currencyMeta(row),receivable=number(first(row.receivable,row.receivables,row.receivableTotal,row.receivable_total,row.accountsReceivable,row.accounts_receivable,row.receivableClosing,row.receivable_closing)),payable=number(first(row.payable,row.payables,row.payableTotal,row.payable_total,row.accountsPayable,row.accounts_payable,row.payableClosing,row.payable_closing));
    return{currency,receivable,payable,net:number(first(row.net,row.netPosition,row.net_position,row.netClosing,row.net_closing,receivable-payable)),partyCount:number(first(row.partyCount,row.party_count,row.thirdPartyCount,row.third_party_count))};
  });
  if(!currencies.length){
    const currencyGroups=new Map();
    for(const row of [...receivables,...payables]){
      const key=String(row.currency.id??row.currency.code),entry=currencyGroups.get(key)||{currency:row.currency,receivable:0,payable:0,net:0,parties:new Set()};
      entry[row.side==='RECEIVABLE'?'receivable':'payable']+=row.closing;entry.net=entry.receivable-entry.payable;
      if(row.party.id!==null&&row.party.id!==undefined)entry.parties.add(`${row.party.type}:${row.party.id}`);
      currencyGroups.set(key,entry);
    }
    currencies=[...currencyGroups.values()].map(item=>({...item,partyCount:item.parties.size}));
  }
  for(const summary of currencies)if(!summary.partyCount)summary.partyCount=new Set([...receivables,...payables].filter(row=>(row.party.id!==null&&row.party.id!==undefined)&&String(row.currency.id??row.currency.code)===String(summary.currency.id??summary.currency.code)).map(row=>`${row.party.type}:${row.party.id}`)).size;
  return{header:{...object(report.header),dateFrom:first(report.dateFrom,report.date_from),dateTo:first(report.dateTo,report.date_to),generatedAt:first(report.generatedAt,report.generated_at)},summary:object(report.summary),currencies,receivables,payables,localPositions,quality:first(report.quality,report.dataQuality,report.data_quality,{}),details};
}
function money(value,currency){const prefix=currency.symbol||currency.code||'';return`${prefix} ${fmt(value)}`.trim()}
function partyCell(party){const label=party.type==='SUPPLIER'?'Proveedor':'Cliente';return`<td class="party-cell"><span class="party-kind ${party.type==='SUPPLIER'?'supplier':'customer'}">${label}</span><b>${esc([party.code,party.name].filter(Boolean).join(' · '))}</b>${party.identification?`<small>${esc(party.identification)}</small>`:''}</td>`}
function currencyCell(currency){return`<td><span class="currency-badge">${esc(currency.code)}</span>${currency.name?`<small>${esc(currency.name)}</small>`:''}</td>`}
function accountCell(account){return`<td class="account-cell"><b>${esc(account.number||'—')}</b><small>${esc(account.name||'Cuenta sin nombre')}</small></td>`}
function subsidiaryCell(subsidiary){return`<td class="subsidiary-cell"><b>${esc(subsidiary.name)}</b></td>`}

function renderMeta(report){const header=report.header,subsidiary=subsidiaryOptions().find(item=>String(subsidiaryIdOf(item))===$('subsidiary').value);$('reportMeta').hidden=false;$('reportMeta').innerHTML=`<span><b>Subsidiaria:</b> ${esc(first(header.subsidiaryName,header.subsidiary_name,labelOf(subsidiary),'Empresa'))}</span><span><b>Libro:</b> ${esc($('book').selectedOptions[0]?.textContent||'Libro principal')}</span><span><b>Período:</b> ${esc(date(first(header.dateFrom,header.date_from,$('dateFrom').value)))} al ${esc(date(first(header.dateTo,header.date_to,$('dateTo').value)))}</span><span><b>Tercero:</b> ${esc($('thirdParty').selectedOptions[0]?.textContent||'Todos')}</span><span><b>Moneda:</b> ${esc($('currency').selectedOptions[0]?.textContent||'Todas')}</span>`}
function renderSummary(report){
  const summary=report.summary,quality=object(report.quality),totalParties=number(first(summary.thirdPartyCount,summary.third_party_count,quality.thirdPartyCount,quality.third_party_count,new Set([...report.receivables,...report.payables].filter(row=>row.party.id!==null&&row.party.id!==undefined).map(row=>`${row.party.type}:${row.party.id}`)).size));
  $('summary').innerHTML=`<div class="summary-heading"><div><small>RESUMEN EJECUTIVO</small><h2>Posición comercial por moneda</h2></div><p>${esc(integer(totalParties))} clientes y proveedores intercompany con movimientos.</p></div><div class="currency-grid">${report.currencies.length?report.currencies.map(item=>`<article class="currency-card"><header><div class="currency-id"><span class="currency-code">${esc(item.currency.code)}</span><div><b>${esc(item.currency.name||item.currency.code)}</b><small>Valores en moneda original</small></div></div><span class="company-count">${esc(integer(item.partyCount))} terceros</span></header><div class="currency-values"><div class="receivable"><small>Clientes por cobrar</small><b>${esc(money(item.receivable,item.currency))}</b></div><div class="payable"><small>Proveedores por pagar</small><b>${esc(money(item.payable,item.currency))}</b></div><div class="net ${item.net<0?'negative':''}"><small>Diferencia informativa</small><b>${esc(money(item.net,item.currency))}</b></div></div></article>`).join(''):'<div class="initial-state"><b>No hay saldos comerciales intercompany para los filtros seleccionados.</b><small>Desactive “Solo documentos con saldo pendiente” o amplíe el período.</small></div>'}</div>`;
}
function qualityIssues(value){if(Array.isArray(value))return value;const quality=object(value);return array(first(quality.issues,quality.warnings,quality.errors,quality.details)).map(item=>typeof item==='string'?{message:item}:item)}
function renderQuality(report){
  const quality=object(report.quality),issues=qualityIssues(report.quality);
  const missingParty=number(first(quality.unassignedPartyMovementCount,quality.unassigned_party_movement_count,quality.missingThirdPartyCount,quality.missing_third_party_count,quality.unassignedThirdPartyCount,quality.unassigned_third_party_count,0));
  const reconciliationDifferences=number(first(quality.reconciliationDifferenceCount,quality.reconciliation_difference_count,0));
  const classificationMismatches=number(first(quality.classificationMismatchCount,quality.classification_mismatch_count,0));
  const problem=quality.valid===false||quality.isValid===false||quality.is_valid===false||missingParty>0||reconciliationDifferences>0||classificationMismatches>0||issues.length>0;
  const controls=[
    missingParty?`<span><b>${integer(missingParty)}</b> movimiento(s) sin cliente o proveedor</span>`:'',
    reconciliationDifferences?`<span><b>${integer(reconciliationDifferences)}</b> diferencia(s) entre auxiliar y Mayor</span>`:'',
    classificationMismatches?`<span><b>${integer(classificationMismatches)}</b> tercero(s) reclasificados en el maestro</span>`:''
  ].filter(Boolean).join('');
  $('quality').hidden=false;$('quality').className=`quality-panel${problem?'':' ok'}`;
  $('quality').innerHTML=`<span class="quality-icon">${problem?'!':'✓'}</span><div><b>${problem?'Se encontraron partidas que requieren revisión':'Auxiliar conciliado e identificado'}</b><small>${problem?'Las partidas se mantienen visibles para facilitar su corrección.':'Los saldos comerciales coinciden con el Mayor y tienen cliente o proveedor identificado.'}</small>${controls?`<div class="quality-breakdown">${controls}</div>`:''}${issues.length?`<ul class="quality-list">${issues.slice(0,8).map(item=>`<li>${esc(first(item.message,item.description,item.label,String(item)))}</li>`).join('')}</ul>`:''}</div>`;
}
function renderBalanceRows(rows,target){
  $(target).innerHTML=rows.length?rows.map(row=>`<tr>${partyCell(row.party)}${currencyCell(row.currency)}<td class="number">${esc(integer(row.openDocumentCount))}</td><td class="number">${esc(money(row.opening,row.currency))}</td><td class="number">${esc(money(row.debit,row.currency))}</td><td class="number">${esc(money(row.credit,row.currency))}</td><td class="number ${row.closing<0?'negative':''}"><b>${esc(money(row.closing,row.currency))}</b></td><td class="number ${row.documentBalance<0?'negative':''}">${esc(money(row.documentBalance,row.currency))}</td><td class="number ${Math.abs(row.difference)>.005?'negative':''}"><b>${esc(money(row.difference,row.currency))}</b></td></tr>`).join(''):'<tr class="empty-row"><td colspan="9">No hay saldos para esta sección.</td></tr>';
}
function positionLabel(net){return Math.abs(net)<.005?['Importes iguales','settled']:net>0?['CxC mayor','receivable']:['CxP mayor','payable']}
function renderNet(report){$('netRows').innerHTML=report.currencies.length?report.currencies.map(row=>{const[label,kind]=positionLabel(row.net);return`<tr>${currencyCell(row.currency)}<td class="number">${esc(money(row.receivable,row.currency))}</td><td class="number">${esc(money(row.payable,row.currency))}</td><td class="number ${row.net<0?'negative':''}"><b>${esc(money(row.net,row.currency))}</b></td><td><span class="position-badge ${kind}">${label}</span></td></tr>`}).join(''):'<tr class="empty-row"><td colspan="5">No hay monedas para mostrar.</td></tr>'; $('netCount').textContent=`${integer(report.currencies.length)} monedas`}
function renderLocalPositions(report){$('localRows').innerHTML=report.localPositions.length?report.localPositions.map(row=>`<tr>${subsidiaryCell(row.subsidiary)}${partyCell(row.party)}${currencyCell(row.originalCurrency)}${currencyCell(row.localCurrency)}<td class="number">${esc(money(row.receivable,row.localCurrency))}</td><td class="number">${esc(money(row.payable,row.localCurrency))}</td><td class="number ${row.net<0?'negative':''}"><b>${esc(money(row.net,row.localCurrency))}</b></td></tr>`).join(''):'<tr class="empty-row"><td colspan="7">No hay equivalencias locales para los filtros seleccionados.</td></tr>';$('localCount').textContent=`${integer(report.localPositions.length)} equivalencias`; $('localSection').hidden=!report.localPositions.length}
function fxLocalAmount(row,value,label){return row.isFxRevaluation?`<small class="fx-local">${label}: ${esc(money(value,row.localCurrency))}</small>`:''}
function renderDetails(report){
  $('detailRows').innerHTML=report.details.length?report.details.map(row=>`<tr><td>${esc(date(row.date))}</td><td>${esc(date(row.dueDate))}</td><td><span class="side-badge ${row.side.toLowerCase()}">${row.side==='PAYABLE'?'Por pagar':'Por cobrar'}</span></td><td class="document-cell">${row.journalId?`<button class="document-link" data-journal="${esc(row.journalId)}">${esc(row.document)}</button>`:`<b>${esc(row.document)}</b>`}${row.journalNumber?`<small>Asiento ${esc(row.journalNumber)}</small>`:''}</td>${partyCell(row.party)}${currencyCell(row.currency)}${accountCell(row.account)}<td><span class="aging-badge">${esc(row.agingBucket)}</span></td><td class="number">${esc(money(row.gross,row.currency))}</td><td class="number">${esc(money(row.applied,row.currency))}</td><td class="number">${esc(money(row.creditNotes,row.currency))}</td><td class="number">${esc(money(row.debitNotes,row.currency))}</td><td class="number ${row.outstanding<0?'negative':''}"><b>${esc(money(row.outstanding,row.currency))}</b></td></tr>`).join(''):'<tr class="empty-row"><td colspan="13">No hay documentos para los filtros seleccionados.</td></tr>';
  $('detailCount').textContent=`${integer(report.details.length)} documentos`;
  document.querySelectorAll('[data-journal]').forEach(button=>button.onclick=()=>location.assign(`/journal-view.html?id=${encodeURIComponent(button.dataset.journal)}`));
}
function render(report){renderMeta(report);renderSummary(report);renderQuality(report);renderBalanceRows(report.receivables,'receivablesRows');renderBalanceRows(report.payables,'payablesRows');$('receivablesCount').textContent=`${integer(report.receivables.length)} registros`;$('payablesCount').textContent=`${integer(report.payables.length)} registros`;renderNet(report);renderLocalPositions(report);renderDetails(report);const direction=$('direction').value;$('receivablesSection').hidden=direction==='PAYABLE';$('payablesSection').hidden=direction==='RECEIVABLE';$('netSection').hidden=direction!=='ALL';$('results').hidden=false}

async function generate(){validateFilters();const requestedFilters=filters(),requestedSignature=JSON.stringify(requestedFilters);setLoading(true);message();try{const payload=await api('/api/v1/reports/accounting/intercompany-commercial',{method:'POST',body:JSON.stringify(requestedFilters)});state.report=normalizeReport(payload);state.lastFilterSignature=requestedSignature;state.dirty=filterSignature()!==requestedSignature;render(state.report);message(state.dirty?'Los filtros cambiaron durante la consulta. Genere nuevamente el reporte antes de descargar.':'Reporte generado correctamente.',!state.dirty)}catch(error){state.report=null;state.lastFilterSignature='';state.dirty=false;$('results').hidden=true;$('reportMeta').hidden=true;$('quality').hidden=true;$('summary').innerHTML='<div class="initial-state"><b>No fue posible generar el reporte.</b><small>Revise los filtros e intente nuevamente.</small></div>';message(error.message)}finally{setLoading(false)}}

function quote(value){
  const raw=String(value??''),safe=/^[=+@\-\t\r]/.test(raw)?`'${raw}`:raw;
  return`"${safe.replaceAll('"','""')}"`;
}
function csvRows(){return(state.report?.details||[]).map(row=>[row.date,row.dueDate,row.side==='PAYABLE'?'CUENTAS POR PAGAR':'CUENTAS POR COBRAR',row.document,row.journalNumber,row.party.type,row.party.code,row.party.name,row.party.identification,row.currency.code,row.account.number,row.account.name,row.agingBucket,row.gross,row.applied,row.creditNotes,row.debitNotes,row.outstanding])}
function downloadBlob(blob,name){const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000)}
function downloadCsv(){if(!canExport())return;const headers=['Fecha','Vencimiento','Tipo de saldo','Documento','Asiento','Tipo de tercero','Código tercero','Cliente / proveedor','Identificación fiscal','Moneda','Cuenta','Nombre de cuenta','Antigüedad','Importe','Cobros / pagos','Notas de crédito','Notas de débito','Saldo pendiente'],rows=csvRows(),csv=[headers,...rows].map(row=>row.map(quote).join(',')).join('\r\n');downloadBlob(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),`cuentas-comerciales-intercompany-${$('dateFrom').value}-${$('dateTo').value}.csv`)}
function responseFilename(response,fallback){const disposition=response.headers.get('content-disposition')||'',encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i),plain=disposition.match(/filename="?([^";]+)"?/i);try{return decodeURIComponent(first(encoded?.[1],plain?.[1],fallback))}catch{return fallback}}
function base64Blob(payload){const bytes=atob(payload.base64),array=new Uint8Array(bytes.length);for(let index=0;index<bytes.length;index++)array[index]=bytes.charCodeAt(index);return new Blob([array],{type:payload.mimeType||'application/octet-stream'})}
async function downloadServer(format){if(!canExport())return;setLoading(true);message();try{const response=await fetch(`/api/v1/reports/accounting/intercompany-commercial/${format}`,{method:'POST',headers:authHeaders(true),body:JSON.stringify(filters())});if(!response.ok){const payload=await response.json().catch(()=>null);throw Error(payload?.error?.message||payload?.message||`No fue posible generar el archivo ${format.toUpperCase()}.`)}const contentType=response.headers.get('content-type')||'',fallback=`cuentas-comerciales-intercompany-${$('dateFrom').value}-${$('dateTo').value}.${format==='excel'?'xlsx':'pdf'}`;if(contentType.includes('application/json')){const payload=await response.json();if(!payload?.base64)throw Error('El servidor no devolvió un archivo válido.');downloadBlob(base64Blob(payload),payload.fileName||fallback)}else downloadBlob(await response.blob(),responseFilename(response,fallback));message(`${format==='excel'?'Excel':'PDF'} generado correctamente.`,true)}catch(error){message(error.message)}finally{setLoading(false)}}

async function init(){setLoading(true);setDefaultDates();try{state.options=object(await api('/api/v1/reports/accounting/intercompany-commercial/options'));const subsidiaries=subsidiaryOptions();fill('subsidiary',subsidiaries,null,item=>labelOf(item),subsidiaryIdOf);const active=localStorage.getItem('nexo_company');if([...$('subsidiary').options].some(option=>option.value===active))$('subsidiary').value=active;populateDependentOptions();setLoading(false);await generate()}catch(error){message(error.message);setLoading(false)}}

$('filters').onsubmit=event=>{event.preventDefault();generate()};
$('subsidiary').onchange=()=>{populateDependentOptions();state.report=null;state.lastFilterSignature='';state.dirty=false;$('results').hidden=true;$('reportMeta').hidden=true;$('quality').hidden=true;$('summary').innerHTML='<div class="initial-state"><span aria-hidden="true">⇄</span><b>Genere el reporte para consultar la cartera comercial intercompany</b><small>Las monedas siempre se presentan por separado.</small></div>';message();setLoading(false)};
$('direction').onchange=()=>{populateDependentOptions();markDirty()};
$('resetFilters').onclick=()=>{setDefaultDates();$('book').value='';$('direction').value='ALL';populateDependentOptions();$('thirdParty').value='';$('currency').value='';$('onlyPending').checked=true;$('search').value='';generate()};
$('downloadCsv').onclick=downloadCsv;
$('downloadExcel').onclick=()=>downloadServer('excel');
$('downloadPdf').onclick=()=>downloadServer('pdf');
$('filters').addEventListener('input',event=>{if(event.target.id!=='generate')markDirty()});
$('filters').addEventListener('change',event=>{if(event.target.id!=='generate')markDirty()});

await init();
