import {escapeHtml} from './html-safety.js?v=20261101-a03-1';
import {bankContext,watchBankContext,lockBankForm,bankAmountInput} from './bank-ui.js?v=20261105-banking-functional';
export function mountBankCsvImport({kind,host,filters,onImported,access={}}){
 if(!['checks','deposits'].includes(kind)||!host)return;
 const button=document.createElement('button');button.type='button';button.className='primary';button.textContent='Importar CSV';button.hidden=access.canCreate===false;host.append(button);
 const dialog=document.createElement('dialog');dialog.className='modal bank-import-modal';dialog.setAttribute('aria-label',kind==='checks'?'Importar cheques o transferencias':'Importar depósitos bancarios');
 dialog.innerHTML=`<div class="modal-head"><div><p class="eyebrow">BANCOS · CARGA MASIVA</p><h2>${kind==='checks'?'Importar cheques o transferencias':'Importar depósitos bancarios'}</h2></div><button type="button" data-close aria-label="Cerrar importación">×</button></div><p class="bank-import-notice">Reemplace los datos de ejemplo por los de la subsidiaria activa. Conserve cuentas bancarias e identificaciones como texto. La vista previa valida los datos; los movimientos se registran únicamente al confirmar.</p><div class="bank-import-templates"><a href="/plantilla-cheques-transferencias.csv" download>Plantilla cheques o transferencias</a><a href="/plantilla-depositos-bancarios.csv" download>Plantilla depósitos bancarios</a></div><label>Archivo CSV<input type="file" accept=".csv,text/csv" data-file></label><small>Máximo 2 MiB, 2.000 filas y 200 documentos. Separador punto y coma; importes sin separadores de miles.</small><p data-status role="status"></p><div data-summary class="bank-import-summary"></div><ul data-errors class="bank-import-errors"></ul><div class="table-wrap"><table class="bank-import-table"><thead><tr><th>Referencia documento</th><th>Tipo</th><th>Fecha</th><th>Cuenta bancaria</th><th>Moneda</th><th class="num">Importe</th><th class="num">Líneas</th></tr></thead><tbody data-rows></tbody></table></div><div class="bank-import-actions"><button type="button" data-close>Cancelar</button><button type="button" data-preview>Validar y ver vista previa</button><button type="button" class="primary" data-confirm disabled>Confirmar importación</button></div>`;
 document.body.append(dialog);
 const file=dialog.querySelector('[data-file]'),previewButton=dialog.querySelector('[data-preview]'),confirmButton=dialog.querySelector('[data-confirm]'),status=dialog.querySelector('[data-status]'),rows=dialog.querySelector('[data-rows]'),summary=dialog.querySelector('[data-summary]'),errors=dialog.querySelector('[data-errors]');
 const initialContext=bankContext();let generation=0,preview=null,previewing=false,saving=false,controller=null,invalidContext=false;
 const filterKey=()=>filters?JSON.stringify([...filters.querySelectorAll('input,select')].map(field=>[field.id,field.value])):'';
 const subsidiary=()=>Number(localStorage.getItem('nexo_company')||sessionStorage.getItem('nexo_company'));
 const role=()=>Number(localStorage.getItem('nexo_role')||sessionStorage.getItem('nexo_role'));
 const fresh=()=>preview&&preview.generation===generation&&preview.context===bankContext()&&preview.filters===filterKey()&&Date.parse(preview.expiresAt)>Date.now();
 function sync(){confirmButton.disabled=saving||previewing||invalidContext||!fresh();previewButton.disabled=saving||previewing||invalidContext||!file.files[0];file.disabled=saving||invalidContext;dialog.querySelectorAll('[data-close]').forEach(control=>control.disabled=saving);}
 function reset(message=''){generation++;controller?.abort();controller=null;preview=null;previewing=false;rows.textContent='';summary.textContent='';errors.textContent='';status.textContent=message;sync();}
 function render(result){
  rows.innerHTML=(result.entries||[]).slice(0,200).map(entry=>`<tr><td>${escapeHtml(entry.reference??'')}</td><td>${escapeHtml(entry.type??'')}</td><td>${escapeHtml(entry.date??'')}</td><td>${escapeHtml(entry.bankAccount??'')}</td><td>${escapeHtml(entry.currency??'')}</td><td class="num">${escapeHtml(bankAmountInput(entry.amount))}</td><td class="num">${escapeHtml(entry.lineCount??0)}</td></tr>`).join('');
  summary.innerHTML=(result.totals||[]).map(total=>`<span><b>${escapeHtml(total.currency??'')}</b>: ${escapeHtml(bankAmountInput(total.amount))} · ${escapeHtml(total.documents??0)} documento(s) · ${escapeHtml(total.lines??0)} línea(s)</span>`).join('');
  errors.innerHTML=(result.errors||[]).slice(0,200).map(item=>`<li>Fila ${escapeHtml(item.row??'—')}${item.reference?` · ${escapeHtml(item.reference)}`:''}${item.field?` · ${escapeHtml(item.field)}`:''}: ${escapeHtml(item.message??'Revise los datos.')}</li>`).join('');
  if((result.errors||[]).length>200){const note=document.createElement('li');note.textContent=`Se muestran 200 de ${result.errors.length} errores. Corrija el archivo completo y vuelva a validar.`;errors.append(note);}
 }
 async function api(action,payload,signal){
  const response=await fetch(`/api/banking/csv/${kind}/${action}`,{method:'POST',signal,headers:{Authorization:`Bearer ${localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token')||''}`,'X-Device-Token':localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'','Content-Type':'application/json'},body:JSON.stringify(payload)}),result=await response.json();
  if(!response.ok)throw Object.assign(Error(result?.error?.message||result?.message||'No fue posible procesar el archivo.'),{payload:result,status:response.status});return result;
 }
 button.onclick=()=>{if(invalidContext||saving)return;reset();dialog.showModal();};
 dialog.querySelectorAll('[data-close]').forEach(control=>control.onclick=()=>{if(saving)return;reset();dialog.close();});
 dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();else reset();});
 file.onchange=()=>{if(saving)return;reset();};
 filters?.addEventListener('input',()=>{if(!saving)reset('Los filtros cambiaron. Vuelva a validar el archivo antes de confirmar.');});
 filters?.addEventListener('change',()=>{if(!saving)reset('Los filtros cambiaron. Vuelva a validar el archivo antes de confirmar.');});
 previewButton.onclick=async()=>{
  if(previewing||saving||invalidContext||!file.files[0])return;
  reset();const selected=file.files[0],request=++generation,context=bankContext(),selectedFilters=filterKey();previewing=true;controller=new AbortController();sync();status.textContent='Validando archivo…';
  try{
   if(!selected.size||selected.size>2*1024*1024)throw Error('Seleccione un CSV con datos de hasta 2 MiB.');
   const csv=await selected.text();if(new TextEncoder().encode(csv).byteLength>2*1024*1024)throw Error('El archivo CSV no debe superar 2 MiB.');
   if(request!==generation||context!==bankContext()||selected!==file.files[0])return;
   const sid=subsidiary();if(!Number.isSafeInteger(sid)||sid<=0)throw Error('Seleccione una subsidiaria autorizada.');
   const result=await api('preview',{csv,subsidiaryId:sid},controller.signal);
   if(request!==generation||context!==bankContext()||selectedFilters!==filterKey()||selected!==file.files[0])return;
   if(Number(result.context?.subsidiaryId)!==sid||Number(result.context?.roleId)!==role())throw Error('La empresa o el rol de la vista previa no corresponde al contexto activo.');
   render(result);
   if(result.alreadyImported)status.textContent='Este archivo ya fue importado. No se crearán movimientos duplicados.';
   else if(result.valid&&typeof result.previewToken==='string'&&Date.parse(result.expiresAt)>Date.now()){
    preview={csv,subsidiaryId:sid,previewToken:result.previewToken,expiresAt:result.expiresAt,generation:request,context,filters:selectedFilters};status.textContent='Archivo válido. Revise los documentos y confirme la importación.';
   }else status.textContent='El archivo contiene errores. Corríjalos y vuelva a validar.';
  }catch(error){if(request===generation){if(error.payload)render(error.payload);status.textContent=error.message;}}
  finally{if(request===generation){previewing=false;controller=null;sync();}}
 };
 confirmButton.onclick=async()=>{
  if(saving||previewing||invalidContext||!fresh()){if(!saving&&!fresh())reset('La vista previa venció o cambió el contexto. Vuelva a validar el archivo.');return;}
  const approved=preview;saving=true;sync();if(filters)lockBankForm(filters,true);status.textContent='Importando documentos…';
  try{
   const result=await api('import',{csv:approved.csv,subsidiaryId:approved.subsidiaryId,previewToken:approved.previewToken});
   if(approved.context!==bankContext()||initialContext!==bankContext()){reset('El contexto cambió. Abra la lista de la empresa correspondiente para consultar el resultado.');return;}
   if(!result.valid){preview=null;render(result);status.textContent='La validación cambió. Revise los errores y vuelva a validar el archivo.';return;}
   preview=null;render(result);status.textContent=result.alreadyImported?'El archivo ya estaba importado. No se crearon duplicados.':`Importación completada: ${Number(result.created)||0} documento(s) registrado(s).`;
   try{await onImported?.();}catch{status.textContent+=' Actualice el listado para consultar los documentos.';}
  }catch(error){if(approved.context===bankContext()){if(error.payload?.errors?.length){render(error.payload);preview=null;}status.textContent=`No fue posible confirmar el resultado: ${error.message} Puede reintentar con el mismo archivo; el servidor evita duplicados.`;}}
  finally{saving=false;if(filters)lockBankForm(filters,false);sync();}
 };
 watchBankContext(()=>{invalidContext=initialContext!==bankContext();reset('La empresa, el rol o la sesión cambió. Vuelva a abrir la pantalla para importar.');button.disabled=invalidContext;});
 sync();return{button,dialog,invalidate:reset};
}
