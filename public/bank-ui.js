// Shared browser primitives for bank forms; authorization remains on the server.
export function bankContext() {
  const value = key => localStorage.getItem(key) || sessionStorage.getItem(key) || '';
  return JSON.stringify([window.NexoSessionRenewal?.current()?.generation || value('nexo_token') || 'anonymous', value('nexo_company'), value('nexo_role'), value('nexo_device_token')]);
}
export function bankRequestScope() {
  let sequence = 0, controller;
  return {
    cancel() { sequence++; controller?.abort(); },
    begin() {
      controller?.abort(); controller = new AbortController();
      const request = ++sequence, context = bankContext(), signal = controller.signal;
      return { signal, current: () => request === sequence && !signal.aborted && bankContext() === context };
    }
  };
}
export function watchBankContext(callback) {
  let previous = bankContext();
  const check = () => { const next = bankContext(); if (next !== previous) { previous = next; callback(); } };
  window.addEventListener('storage', check);
  window.addEventListener('focus', check);
  try { window.top.addEventListener('nexo:approval-context-changed', check); } catch { /* Same-origin workspace is required by the shell. */ }
  return check;
}
export function parseBankAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let text = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '');
  if (!text) return 0;
  if (!/^-?\d+(?:[.,]\d+)*$/.test(text)) return NaN;
  const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) text = comma > dot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (comma >= 0) text = text.replace(',', '.');
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : NaN;
}
export const bankAmountInput = value => Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : String(value ?? '');
export const validBankAmount = value => Number.isFinite(value) && Number(value.toFixed(6)) === value;
export const bankRate = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(Number(value).toFixed(10)) : 0;
export const bankMasterActive = row => ![true,'true',1,'1'].includes(row?.is_inactive) && ![false,'false',0,'0'].includes(row?.is_active);
export function preserveBankSelection(field,value,label){
  if(!field||value===null||value===undefined||value==='')return;
  const id=String(value);if(![...field.options].some(option=>option.value===id)){const option=document.createElement('option');option.value=id;option.textContent=`${label||`Referencia #${id}`} · Referencia histórica`;option.disabled=true;field.append(option);}field.value=id;
}
export const bankMoney = value => Number(value || 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function lockBankForm(container, locked, except = []) {
  for (const field of container.querySelectorAll('input,select,textarea,button')) {
    if (except.includes(field)) continue;
    if (locked) { if (field.dataset.bankWasDisabled === undefined) field.dataset.bankWasDisabled = String(field.disabled); field.disabled = true; }
    else if (field.dataset.bankWasDisabled !== undefined) { field.disabled = field.dataset.bankWasDisabled === 'true'; delete field.dataset.bankWasDisabled; }
  }
}
export function protectBankNavigation(isSaving,notice) {
  document.addEventListener('click',event=>{if(isSaving()&&event.target.closest?.('a[href]')){event.preventDefault();event.stopImmediatePropagation();notice?.('Espere a que termine el guardado antes de salir.');}},true);
  window.addEventListener('beforeunload',event=>{if(isSaving()){event.preventDefault();event.returnValue='';}});
}
export function parseBankCsvRows(source,maxRows=2000){
  const text=String(source??'').replace(/^\uFEFF/,''),separator=text.split(/\r?\n/,1)[0].includes(';')?';':',';
  const rows=[];let row=[],field='',quoted=false,closed=false;
  const pushField=()=>{row.push(field.trim());field='';closed=false;};
  const pushRow=()=>{pushField();if(row.some(value=>value!==''))rows.push(row);row=[];if(rows.length>maxRows+1)throw Error(`El CSV no puede superar ${maxRows} filas.`);};
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(quoted){if(char==='"'){if(text[index+1]==='"'){field+='"';index++;}else{quoted=false;closed=true;}}else field+=char;continue;}
    if(char==='"'){if(field.trim()||closed)throw Error('El archivo CSV contiene comillas inválidas.');quoted=true;continue;}
    if(char===separator){pushField();continue;}
    if(char==='\r'||char==='\n'){if(char==='\r'&&text[index+1]==='\n')index++;pushRow();continue;}
    if(closed&&!/\s/.test(char))throw Error('El archivo CSV contiene datos después de una comilla de cierre.');field+=char;
  }
  if(quoted)throw Error('El archivo CSV contiene un campo sin cerrar.');pushRow();
  if(!rows.length)throw Error('El archivo CSV está vacío.');
  const width=rows[0].length;rows.forEach((record,index)=>{if(record.length!==width)throw Error(`La fila ${index+1} no contiene las ${width} columnas del encabezado.`);});return rows;
}
