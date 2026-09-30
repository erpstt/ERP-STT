(()=>{
  if(window!==window.top)return;
  const token=localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');
  if(!token)return;
  const device=localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'';
  const headers={Authorization:`Bearer ${token}`,'X-Device-Token':device};
  const openWorkspace=(url,module,section)=>window.dispatchEvent(new CustomEvent('nexo:open-workspace',{detail:{url,module,section}}));
  const approvals=document.createElement('button');
  approvals.className='nexo-alert-button nexo-approval-bell';approvals.type='button';approvals.title='Mis aprobaciones';approvals.setAttribute('aria-label','Abrir mis aprobaciones');approvals.innerHTML='<span aria-hidden="true">🔔</span> <b>0</b>';
  approvals.onclick=()=>openWorkspace('/approval-inbox.html','Workflow','Mis aprobaciones');
  const taxes=document.createElement('button');
  taxes.className='nexo-alert-button nexo-tax-bell';taxes.type='button';taxes.title='Alertas del calendario tributario';taxes.setAttribute('aria-label','Abrir alertas del calendario tributario');taxes.innerHTML='<span aria-hidden="true">▣</span> <b>0</b>';taxes.hidden=true;
  taxes.onclick=()=>openWorkspace('/tax-calendar.html?notifications=1','Fiscal','Calendario tributario');
  document.body.append(approvals,taxes);
  const style=document.createElement('style');
  style.textContent='.nexo-alert-button{position:fixed;bottom:18px;z-index:9000;border:0;border-radius:999px;background:#042e72;color:#fff;padding:11px 14px;box-shadow:0 5px 18px #042e7238;font-weight:700}.nexo-alert-button b{background:#fff;color:#042e72;border-radius:99px;padding:2px 6px}.nexo-approval-bell{right:18px}.nexo-tax-bell{right:88px;background:#f26938}.nexo-tax-bell b{color:#c94b1f}.nexo-alert-button:focus-visible{outline:3px solid #f2693855;outline-offset:2px}';
  document.head.append(style);
  async function poll(){
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Costa_Rica',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const [approvalResult,taxResult]=await Promise.allSettled([
      fetch('/api/approval-engine/inbox',{headers}),
      fetch('/api/tax-calendar/list',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({dateFrom:today,dateTo:today})})
    ]);
    if(approvalResult.status==='fulfilled')try{const data=await approvalResult.value.json();if(approvalResult.value.ok)approvals.querySelector('b').textContent=String(Array.isArray(data)?data.length:0);}catch{}
    if(taxResult.status==='fulfilled')try{const data=await taxResult.value.json(),count=(data.notifications||[]).filter(item=>!item.readAt).length;if(taxResult.value.ok){taxes.querySelector('b').textContent=count>99?'99+':String(count);taxes.hidden=!count;}}catch{}
  }
  void poll();setInterval(()=>void poll(),60000);
})();
