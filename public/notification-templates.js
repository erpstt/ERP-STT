const $=id=>document.getElementById(id);
const kinds={
 PAGO_PROVEEDOR:{
  title:'Notificación Pago a Proveedores',
  tags:['empresa_nombre','proveedor_nombre','fecha_pago','referencia_pago','total_pagado','moneda'],
  active:'Habilitar notificaciones para esta subsidiaria',
  activeHelp:'También requiere que el envío SMTP esté activado en el servidor. Los pagos anteriores no se envían automáticamente.',
  automatic:'El logo, las facturas, las retenciones y el total transferido se agregan automáticamente.',
  preview:'Ejemplo de un abono parcial. Esta vista no envía correos.',
  transport:'SMTP activado. Los nuevos pagos con plantilla habilitada se enviarán en segundo plano.'
 },
 ESTADO_CUENTA:{
  title:'Envío de Estado de Cuenta',
  tags:['empresa_nombre','cliente_nombre','fecha_corte','saldo_total','moneda'],
  active:'Habilitar estados de cuenta automáticos para esta subsidiaria',
  activeHelp:'También requiere que el envío SMTP esté activado en el servidor y que el cliente tenga habilitado el envío automático.',
  automatic:'El resumen del saldo y el PDF completo se agregan automáticamente.',
  preview:'Ejemplo de estado de cuenta mensual. Esta vista no envía correos.',
  schedule:'Envío mensual: según el día y la hora configurados (Costa Rica), con corte al cierre del mes anterior. Solo clientes habilitados con saldo neto positivo. El PDF se adjunta automáticamente.',
  transport:'SMTP activado. Se aplicará la programación mensual a los clientes habilitados.'
 },
 FACTURA_VENTA:{
  title:'Envío de Facturas de Venta',
  tags:['empresa_nombre','cliente_nombre','numero_factura','fecha_factura','fecha_vencimiento','total_factura','moneda'],
  active:'Habilitar envío de facturas para esta subsidiaria',
  activeHelp:'La factura se envía manualmente desde su vista de detalle al correo registrado en el cliente.',
  automatic:'El PDF de la factura y todos los archivos de respaldo cargados se adjuntan automáticamente. Los respaldos registrados como enlaces se incluyen como enlaces seguros en el mensaje.',
  preview:'Ejemplo de una factura de venta. Esta vista no envía correos.',
  schedule:'Envío manual: el usuario revisa el destinatario y confirma el envío desde la factura de venta.',
  transport:'SMTP activado. Las facturas podrán enviarse desde su vista de detalle.'
 },
 SOLICITUD_GASTO_APROBACION:{
  title:'Solicitud de gasto pendiente de aprobación',
  tags:['empresa_nombre','aprobador_nombre','numero_solicitud','solicitante_nombre','tipo_solicitud','fecha_solicitud','fecha_pago_programada','moneda','monto_total','concepto','departamentos','centros_costo','nivel_aprobacion','enlace_solicitud'],
  active:'Notificar por correo las solicitudes de gasto pendientes',
  activeHelp:'Se envía al aprobador asignado cuando una solicitud de tipo Otros Pagos entra en su nivel de aprobación. También requiere que el SMTP esté activo.',
  automatic:'El resumen de la solicitud, el monto, el departamento, los centros de costo, el botón para revisarla y las instrucciones de aprobación se agregan automáticamente.',
  preview:'Ejemplo de una solicitud de gasto pendiente. Esta vista no envía correos ni aprueba transacciones.',
  schedule:'Envío automático: se genera al enviar la solicitud a aprobación y en cada nuevo nivel aplicable.',
  transport:'SMTP activado. Las nuevas solicitudes de gasto se notificarán al aprobador correspondiente.'
 }
};
const requested=new URLSearchParams(location.search).get('kind');
const kind=Object.hasOwn(kinds,requested)?requested:'PAGO_PROVEEDOR',settings=kinds[kind];
$('notificationType').value=kind;
$('notificationType').onchange=()=>location.assign('/notification-templates.html?kind='+encodeURIComponent($('notificationType').value));
$('typeTitle').textContent=settings.title;
$('activeLabel').textContent=settings.active;
$('activeHelp').textContent=settings.activeHelp;
$('automaticHelp').textContent=settings.automatic;
$('previewHelp').textContent=settings.preview;
$('schedule').textContent=settings.schedule||'';
if(kind==='ESTADO_CUENTA'){$('scheduleFields').hidden=false;$('sendDay').required=true;$('sendTime').required=true;}
const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
const headers={Authorization:`Bearer ${token}`,'X-Device-Token':localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'','Content-Type':'application/json'};
async function api(action,payload={}){const response=await fetch(`/api/configuration/notification-templates/${action}`,{method:'POST',headers,body:JSON.stringify({...payload,kind})});const data=await response.json();if(!response.ok)throw Error(data?.error?.message||'No fue posible cargar la configuración.');return data;}
function report(text,error=false){$('message').textContent=text;$('message').dataset.error=String(error);}
const payload=()=>({subject:$('subject').value,body:$('editor').innerHTML,active:$('active').checked,...(kind==='ESTADO_CUENTA'?{day:Number($('sendDay').value),time:$('sendTime').value}:{})});
let target=$('editor'),range;
$('subject').addEventListener('focus',()=>target=$('subject'));
$('editor').addEventListener('focus',()=>target=$('editor'));
document.addEventListener('selectionchange',()=>{const selection=getSelection();if(selection.rangeCount&&$('editor').contains(selection.anchorNode))range=selection.getRangeAt(0).cloneRange();});
function restore(){$('editor').focus();if(range){const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}}
document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>{restore();document.execCommand(button.dataset.command,false);}));
$('addLink').addEventListener('click',()=>{const url=prompt('Dirección del enlace (https://…)');if(!url)return;if(!/^https?:\/\//i.test(url)){report('Ingrese un enlace http o https.',true);return;}restore();document.execCommand('createLink',false,url);});
$('editor').addEventListener('paste',event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));});
for(const tag of settings.tags){const button=document.createElement('button');button.type='button';button.textContent=`{{${tag}}}`;button.addEventListener('click',()=>{if(target===$('subject')){$('subject').setRangeText(button.textContent,$('subject').selectionStart,$('subject').selectionEnd,'end');$('subject').focus();}else{restore();document.execCommand('insertText',false,button.textContent);}});$('variables').append(button);}
async function preview(){const data=await api('preview',payload());$('previewSubject').textContent=data.subject;$('preview').srcdoc=data.html;}
$('previewButton').addEventListener('click',async()=>{try{await preview();report('Vista previa actualizada.');}catch(error){report(error.message,true);}});
$('form').addEventListener('submit',async event=>{event.preventDefault();$('save').disabled=true;try{const data=await api('save',payload());$('editor').innerHTML=data.template.cuerpo_template;$('audit').textContent=`Última edición: ${data.template.updated_by_email||'sistema'} · ${new Date(data.template.updated_at).toLocaleString('es-CR')}`;await preview();report('Plantilla guardada.');}catch(error){report(error.message,true);}finally{$('save').disabled=false;}});
try{
 const data=await api('get');
 $('company').textContent=data.subsidiary?.name||'';
 $('sendDay').value=data.template?.envio_dia??1;
 $('sendTime').value=(data.template?.envio_hora||'08:00').slice(0,5);
 $('subject').value=data.template?.asunto_template||data.defaults.subject;
 // HTML returned by the server is sanitized before insertion.
 $('editor').innerHTML=data.template?.cuerpo_template||data.defaults.body;
 $('active').checked=!!data.template?.activo;
 $('transport').textContent=data.transport.enabled?settings.transport:'Envío desactivado. Puede preparar y guardar la plantilla; faltan la configuración SMTP y su activación en el servidor.';
 $('save').disabled=false;
 await preview();
}catch(error){report(error.message,true);$('transport').textContent='No fue posible consultar la configuración.';}
