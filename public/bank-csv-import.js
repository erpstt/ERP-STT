import {escapeHtml} from './html-safety.js?v=20261101-a03-1';
import {bankContext,watchBankContext,lockBankForm,bankAmountInput} from './bank-ui.js?v=20261105-banking-functional';
export function mountBankCsvImport({kind,host,filters,onImported,access={}}){
 if(!['checks','deposits'].includes(kind)||!host)return;
 const button=document.createElement('button');button.type='button';button.className='primary';button.textContent='Importar CSV';button.hidden=access.canCreate===false;host.append(button);
 const checks=kind==='checks',title=checks?'Importar cheques o transferencias':'Importar depósitos bancarios',template=checks?'/plantilla-cheques-transferencias.csv':'/plantilla-depositos-bancarios.csv',fileId='bank-import-file-'+kind;
 const dialog=document.createElement('dialog');dialog.className='modal bank-import-modal';dialog.setAttribute('aria-label',title);
 dialog.innerHTML=`
 <div class="modal-head"><div><p class="eyebrow">BANCOS · CARGA MASIVA</p><h2>${title}</h2></div><button type="button" data-close aria-label="Cerrar importación">×</button></div>
 <ol class="bank-import-steps" aria-label="Proceso de importación">
  <li class="step-upload"><b>1</b><div><strong>Seleccione el archivo</strong><span>Use nuestra plantilla CSV</span></div></li>
  <li class="step-review"><b>2</b><div><strong>Revise la validación</strong><span>Compruebe los datos del lote</span></div></li>
  <li class="step-save"><b>3</b><div><strong>${checks?'Importe los movimientos':'Importe los depósitos'}</strong><span>Confirme el registro contable</span></div></li>
 </ol>
 <div class="bank-import-upload-layout">
  <section class="bank-import-card bank-import-upload-card" aria-label="Cargar archivo CSV">
   <div class="bank-import-card-heading"><div><span class="eyebrow">PASO 1</span><h3>Cargar archivo CSV</h3></div><span class="bank-import-format-badge">.CSV</span></div>
   <label class="bank-import-file-zone" for="${fileId}">
    <span class="bank-import-upload-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/></svg></span>
    <strong data-file-name>Seleccione su archivo CSV</strong><span data-file-detail>Haga clic para buscar un archivo en su equipo</span><span class="bank-import-choose-file">Seleccionar archivo</span>
    <input id="${fileId}" type="file" accept=".csv,text/csv" data-file aria-label="Archivo CSV" aria-describedby="${fileId}-limits">
   </label>
   <div id="${fileId}-limits" class="bank-import-file-limits"><span>Hasta <b>2 MB</b></span><span><b>2.000</b> líneas</span><span><b>200</b> documentos por lote</span></div>
   <div class="bank-import-actions"><span data-action-hint>Valide el archivo antes de importar.</span><div><button type="button" class="secondary" data-preview>Validar archivo</button><button type="button" class="primary" data-confirm disabled>${checks?'Importar movimientos':'Importar depósitos'} <span aria-hidden="true">→</span></button></div></div>
  </section>
  <aside class="bank-import-card bank-import-help-card">
   <span class="eyebrow">ANTES DE COMENZAR</span><h3>Prepare su archivo</h3><p>Utilice la plantilla de este módulo y reemplace los ejemplos con los datos de la subsidiaria activa.</p>
   <a class="bank-import-template-link" href="${template}" download aria-label="Descargar plantilla CSV de ${checks?'cheques o transferencias':'depósitos bancarios'}"><span aria-hidden="true">↓</span> Descargar plantilla CSV</a>
   <ul class="bank-import-checklist"><li>Una fila por línea del movimiento.</li><li>La misma referencia agrupa las líneas de un documento.</li><li>Indique importes positivos en la moneda de la cuenta bancaria.</li><li>${checks?'El tipo de cambio es automático según la moneda y fecha del documento.':'Se utiliza el tipo de cambio indicado en el archivo.'}</li></ul>
   <details class="bank-import-instructions"><summary>Ver instrucciones completas <span aria-hidden="true">ⓘ</span></summary><ol>
    <li>Conserve los encabezados de la plantilla. Reemplace los campos REEMPLAZAR_… y guarde el archivo como CSV UTF-8 separado por punto y coma. También se aceptan comas con los campos correctamente entrecomillados.</li>
    <li>Repita <strong>documento_referencia</strong> y los datos de encabezado en todas las líneas de un documento. Use una referencia nueva para cada movimiento nuevo.</li>
    <li>Complete <strong>fecha</strong> como AAAA-MM-DD, dentro de un período abierto. Indique el número exacto de la cuenta bancaria en <strong>cuenta_bancaria</strong> y la cuenta contable de contrapartida en <strong>numero_cuenta</strong>.</li>
    <li>La <strong>moneda</strong> debe corresponder a la cuenta bancaria. ${checks?'El tipo de cambio se obtiene automáticamente del catálogo para la fecha del documento: se utiliza 1 en moneda local; en moneda extranjera, la última cotización directa vigente hasta esa fecha y, sólo si no existe directa, la inversa. No se utiliza una cotización futura.':'El <strong>tipo_cambio</strong> indica unidades de moneda local por unidad de la moneda del documento; use 1 para moneda local.'}</li>
    ${checks?'<li>Revise el tipo de cambio aplicado y la fecha de cotización en la vista previa. Si no existe una tasa válida, el archivo no se puede importar. La plantilla nueva no incluye <strong>tipo_cambio</strong>; si utiliza una plantilla anterior con esa columna, su valor se ignora.</li>':''}
    <li>Indique importes sin separadores de miles, con punto o coma decimal y hasta seis decimales. ${checks?'':'El tipo de cambio admite diez decimales. '}Conserve cuentas bancarias e identificaciones como texto para mantener los ceros iniciales.</li>
    <li>${checks?'Use CHEQUE o TRANSFERENCIA en <strong>tipo_movimiento</strong> y complete el beneficiario y la referencia bancaria.':'Complete <strong>metodo_pago</strong> con el código del método habilitado para cada línea.'}</li>
    <li>Para terceros, indique su tipo e identificación fiscal; para empleados, su número de empleado. Use los nombres exactos de departamentos, centros de costos y demás referencias habilitadas. La ubicación es opcional; si se omite, no se asigna.</li>
   </ol></details>
   <div class="bank-import-batch-note"><strong>Registro completo del lote</strong><p>Si un documento presenta errores, no se guarda ninguno. Corrija el archivo y vuelva a validarlo.</p></div>
  </aside>
 </div>
 <p data-status role="status" aria-live="polite"></p>
 <section class="bank-import-review-panel bank-import-card" data-review-panel hidden><div class="bank-import-card-heading"><div><span class="eyebrow">REVISIÓN DEL LOTE</span><h3 data-review-title>Vista previa de documentos</h3></div></div><div data-summary class="bank-import-summary"></div><ul data-errors class="bank-import-errors" aria-label="Errores de validación"></ul><div class="table-wrap"><table class="bank-import-table"><thead><tr><th>Referencia documento</th><th>Tipo</th><th>Fecha</th><th>Cuenta bancaria</th><th>Moneda</th>${checks?'<th class="num">Tipo de cambio aplicado</th><th>Fecha de cotización</th>':''}<th class="num">Importe</th><th class="num">Líneas</th></tr></thead><tbody data-rows></tbody></table></div></section>
 <div class="bank-import-footer"><button type="button" data-close>Cancelar</button></div>`;
 document.body.append(dialog);
 const file=dialog.querySelector('[data-file]'),previewButton=dialog.querySelector('[data-preview]'),confirmButton=dialog.querySelector('[data-confirm]'),status=dialog.querySelector('[data-status]'),rows=dialog.querySelector('[data-rows]'),summary=dialog.querySelector('[data-summary]'),errors=dialog.querySelector('[data-errors]'),reviewPanel=dialog.querySelector('[data-review-panel]');
 const initialContext=bankContext();let generation=0,preview=null,previewing=false,saving=false,controller=null,invalidContext=false;
 const filterKey=()=>filters?JSON.stringify([...filters.querySelectorAll('input,select')].map(field=>[field.id,field.value])):'';
 const subsidiary=()=>Number(localStorage.getItem('nexo_company')||sessionStorage.getItem('nexo_company'));
 const role=()=>Number(localStorage.getItem('nexo_role')||sessionStorage.getItem('nexo_role'));
 const fresh=()=>preview&&preview.generation===generation&&preview.context===bankContext()&&preview.filters===filterKey()&&Date.parse(preview.expiresAt)>Date.now();
 function phase(value,tone=''){
  dialog.dataset.phase=value;status.dataset.tone=tone;
  const current=value==='upload'?1:['importing','done'].includes(value)?3:2;
  dialog.querySelectorAll('.bank-import-steps li').forEach((step,index)=>{if(index+1===current)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');step.dataset.stepState=value==='done'||index+1<current?'complete':index+1===current?'current':'pending';});
  dialog.querySelector('[data-action-hint]').textContent=({upload:'Valide el archivo antes de importar.',validating:'Validando los datos del archivo…',review:'Revise la vista previa antes de importar.',importing:'Registrando el lote…',done:'Consulte el resultado del lote en esta pantalla.',error:'Corrija los datos y vuelva a validar el archivo.'})[value];
  dialog.querySelector('[data-review-title]').textContent=value==='done'?'Resultado de la importación':'Vista previa de documentos';
 }
 function sync(){confirmButton.disabled=saving||previewing||invalidContext||!fresh();previewButton.disabled=saving||previewing||invalidContext||!file.files[0];file.disabled=saving||invalidContext;dialog.querySelectorAll('[data-close]').forEach(control=>control.disabled=saving);dialog.setAttribute('aria-busy',String(saving||previewing));const selected=file.files[0];dialog.querySelector('[data-file-name]').textContent=selected?.name||'Seleccione su archivo CSV';dialog.querySelector('[data-file-detail]').textContent=selected?`${(selected.size/1024).toLocaleString('es-CR',{maximumFractionDigits:1})} KB · Puede seleccionar otro archivo para reemplazarlo`:'Haga clic para buscar un archivo en su equipo';}
 function reset(message=''){generation++;controller?.abort();controller=null;preview=null;previewing=false;rows.textContent='';summary.textContent='';errors.textContent='';reviewPanel.hidden=true;status.textContent=message;phase('upload');sync();}
 function render(result){
  const hasContent=Boolean(result.entries?.length||result.errors?.length||result.totals?.length||result.alreadyImported);reviewPanel.hidden=!hasContent;
  const rateText=value=>{const raw=String(value??'');return /^\d+(?:\.\d{1,10})?$/.test(raw)&&Number.isFinite(Number(raw))&&Number(raw)>0?raw.replace('.',','):'—';},sourceText=value=>({LOCAL:'Moneda local',DIRECT:'Cotización directa',INVERSE:'Cotización inversa'})[value]||'Origen de cotización no indicado';
  rows.innerHTML=(result.entries||[]).slice(0,200).map(entry=>`<tr><td>${escapeHtml(entry.reference??'')}</td><td>${escapeHtml(entry.type??'')}</td><td>${escapeHtml(entry.date??'')}</td><td>${escapeHtml(entry.bankAccount??'')}</td><td>${escapeHtml(entry.currency??'')}</td>${checks?`<td class="num" data-exchange-rate title="${escapeHtml(sourceText(entry.rateSource))}" aria-label="${escapeHtml(`${rateText(entry.exchangeRate)} · ${sourceText(entry.rateSource)}`)}">${escapeHtml(rateText(entry.exchangeRate))}</td><td data-rate-date>${escapeHtml(entry.rateSource==='LOCAL'||!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.rateDate??''))?'—':entry.rateDate)}</td>`:''}<td class="num">${escapeHtml(bankAmountInput(entry.amount))}</td><td class="num">${escapeHtml(entry.lineCount??0)}</td></tr>`).join('');
  summary.innerHTML=(result.totals||[]).map(total=>`<span><b>${escapeHtml(total.currency??'')}</b>: ${escapeHtml(bankAmountInput(total.amount))} · ${escapeHtml(total.documents??0)} documento(s) · ${escapeHtml(total.lines??0)} línea(s)</span>`).join('');
  errors.innerHTML=(result.errors||[]).slice(0,200).map(item=>`<li>Fila ${escapeHtml(item.row??'—')}${item.reference?` · ${escapeHtml(item.reference)}`:''}${item.field?` · ${escapeHtml(item.field)}`:''}: ${escapeHtml(item.message??'Revise los datos.')}</li>`).join('');
  if((result.errors||[]).length>200){const note=document.createElement('li');note.textContent=`Se muestran 200 de ${result.errors.length} errores. Corrija el archivo completo y vuelva a validar.`;errors.append(note);}
  if(hasContent){dialog.querySelector('.bank-import-instructions').open=false;reviewPanel.scrollIntoView({block:'start'});}
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
  reset();const selected=file.files[0],request=++generation,context=bankContext(),selectedFilters=filterKey();previewing=true;controller=new AbortController();phase('validating');sync();status.textContent='Validando archivo…';
  try{
   if(!selected.size||selected.size>2*1024*1024)throw Error('Seleccione un CSV con datos de hasta 2 MiB.');
   const csv=await selected.text();if(new TextEncoder().encode(csv).byteLength>2*1024*1024)throw Error('El archivo CSV no debe superar 2 MiB.');
   if(request!==generation||context!==bankContext()||selected!==file.files[0])return;
   const sid=subsidiary();if(!Number.isSafeInteger(sid)||sid<=0)throw Error('Seleccione una subsidiaria autorizada.');
   const result=await api('preview',{csv,subsidiaryId:sid},controller.signal);
   if(request!==generation||context!==bankContext()||selectedFilters!==filterKey()||selected!==file.files[0])return;
   if(Number(result.context?.subsidiaryId)!==sid||Number(result.context?.roleId)!==role())throw Error('La empresa o el rol de la vista previa no corresponde al contexto activo.');
   render(result);
   if(result.alreadyImported){phase('done','success');status.textContent='Este archivo ya fue importado. No se crearán movimientos duplicados.';}
   else if(result.valid&&typeof result.previewToken==='string'&&Date.parse(result.expiresAt)>Date.now()){
    preview={csv,subsidiaryId:sid,previewToken:result.previewToken,expiresAt:result.expiresAt,generation:request,context,filters:selectedFilters};phase('review','success');status.textContent='Archivo válido. Revise los documentos y confirme la importación.';
   }else{phase('error','error');status.textContent='El archivo contiene errores. Corríjalos y vuelva a validar.';}
  }catch(error){if(request===generation){if(error.payload)render(error.payload);phase('error','error');status.textContent=error.message;if(reviewPanel.hidden)status.scrollIntoView({block:'nearest'});}}
  finally{if(request===generation){previewing=false;controller=null;sync();}}
 };
 confirmButton.onclick=async()=>{
  if(saving||previewing||invalidContext||!fresh()){if(!saving&&!fresh())reset('La vista previa venció o cambió el contexto. Vuelva a validar el archivo.');return;}
  const approved=preview;saving=true;phase('importing');sync();if(filters)lockBankForm(filters,true);status.textContent='Importando documentos…';
  try{
   const result=await api('import',{csv:approved.csv,subsidiaryId:approved.subsidiaryId,previewToken:approved.previewToken});
   if(approved.context!==bankContext()||initialContext!==bankContext()){reset('El contexto cambió. Abra la lista de la empresa correspondiente para consultar el resultado.');phase('error','error');return;}
   if(!result.valid){preview=null;render(result);phase('error','error');status.textContent='La validación cambió. Revise los errores y vuelva a validar el archivo.';return;}
   preview=null;render(result);phase('done','success');status.textContent=result.alreadyImported?'El archivo ya estaba importado. No se crearon duplicados.':`Importación completada: ${Number(result.created)||0} documento(s) registrado(s).`;
   try{await onImported?.();}catch{status.textContent+=' Actualice el listado para consultar los documentos.';}
  }catch(error){if(approved.context===bankContext()){if(error.payload?.errors?.length){render(error.payload);preview=null;}if(checks&&error.status===409){preview=null;phase('error','error');status.textContent=`No fue posible confirmar el resultado: ${error.message} Vuelva a validar el archivo para revisar el tipo de cambio aplicado.`;}else{phase(fresh()?'review':'error','error');status.textContent=`No fue posible confirmar el resultado: ${error.message} Puede reintentar con el mismo archivo; el servidor evita duplicados.`;}}}
  finally{saving=false;if(filters)lockBankForm(filters,false);sync();}
 };
 watchBankContext(()=>{invalidContext=initialContext!==bankContext();reset('La empresa, el rol o la sesión cambió. Vuelva a abrir la pantalla para importar.');phase('error','error');button.disabled=invalidContext;});
 phase('upload');sync();return{button,dialog,invalidate:reset};
}
