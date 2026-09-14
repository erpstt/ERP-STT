(() => {
  const actorNames = { HUMAN: 'Usuario humano', AI_AGENT: 'Agente IA / LLM', SYSTEM_JOB: 'Proceso de sistema', EXTERNAL_API: 'API externa' };
  class RecordAudit extends HTMLElement {
    static observedAttributes = ['table', 'record-id'];
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() { this.schedule(); }
    disconnectedCallback() { this.controller?.abort(); }
    attributeChangedCallback() { this.schedule(); }
    schedule() {
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => { this.queued = false; if (this.isConnected) void this.load(); });
    }
    frame() {
      this.shadowRoot.innerHTML = `<style>
        :host{display:block;margin:12px 0;grid-column:1/-1;color:#253d4c;font:13px/1.5 Arial,sans-serif}
        section{border:1px solid #d6e4e8;border-radius:8px;background:#f5f9fa;padding:14px 16px}
        h3{font-size:13px;margin:0 0 10px;color:#315362} .actors{display:grid;grid-template-columns:1fr 1fr;gap:16px}
        h4{margin:0 0 4px;font-size:12px;font-weight:400;color:#526875}strong,span{display:block;overflow-wrap:anywhere}
        strong{font-size:14px}small{display:block;color:#526875}p{margin:0}details{margin-top:10px}summary{cursor:pointer;color:#315362}
        button{margin-left:8px;padding:4px 8px;cursor:pointer}.error{color:#9b3029}
        @media(max-width:600px){.actors{grid-template-columns:1fr}}@media print{:host{display:none}}
      </style><section aria-label="Autoría del registro"><h3>Autoría del registro</h3><div class="content" aria-live="polite"></div></section>`;
      return this.shadowRoot.querySelector('.content');
    }
    async load() {
      this.controller?.abort();
      const controller = this.controller = new AbortController();
      const content = this.frame(), table = this.getAttribute('table'), id = this.getAttribute('record-id');
      if (!id) { content.textContent = 'El creador se registrará automáticamente al guardar.'; return; }
      content.textContent = 'Consultando quién creó o modificó este registro…';
      try {
        if (!table) throw new Error('No fue posible identificar el registro.');
        const response = await fetch(`/api/audit/record-actor?${new URLSearchParams({ table, id })}`, {
          signal: controller.signal, cache: 'no-store', headers: {
            Authorization: `Bearer ${localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token') || ''}`,
            'X-Device-Token': localStorage.getItem('nexo_device_token') || sessionStorage.getItem('nexo_device_token') || ''
          }
        });
        const row = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(row.error?.message || 'No fue posible consultar la autoría.');
        if (!row) throw new Error('El registro no está disponible con sus permisos actuales.');
        this.render(content, row);
      } catch (error) {
        if (controller.signal.aborted) return;
        content.textContent = error.message;
        content.classList.add('error');
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Reintentar';
        retry.onclick = () => this.load(); content.append(retry);
      }
    }
    render(content, row) {
      content.replaceChildren();
      const actors = document.createElement('div'); actors.className = 'actors';
      const legacy = row.created_by_email === 'legacy-unknown@nexo.invalid';
      for (const update of [false, true]) {
        const box = document.createElement('div'), label = document.createElement('h4');
        label.textContent = update ? 'Última modificación por' : 'Creado por'; box.append(label);
        const name = row[update ? 'updated_by_name' : 'created_by_name'];
        const email = row[update ? 'updated_by_email' : 'created_by_email'];
        const kind = row[update ? 'updated_actor_type' : 'actor_type'];
        if (!update && legacy) {
          const note = document.createElement('p'); note.textContent = 'Autor original no disponible. Registro anterior a la activación de la auditoría.'; box.append(note);
        } else if (!name && !email) {
          const note = document.createElement('p'); note.textContent = legacy ? 'Sin modificaciones registradas desde la activación de la auditoría.' : 'Sin modificaciones registradas.'; box.append(note);
        } else {
          const title = document.createElement('strong'), mail = document.createElement('span'), type = document.createElement('small');
          title.textContent = name || email; mail.textContent = email || ''; type.textContent = actorNames[kind] || kind || '';
          box.append(title, mail, type);
        }
        actors.append(box);
      }
      content.append(actors);
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = 'Ver origen de la operación'; details.append(summary);
      for (const [label, key] of [['Origen de creación', 'actor_source'], ['Origen de modificación', 'updated_actor_source'], ['Referencia de creación', 'execution_context_id'], ['Referencia de modificación', 'updated_execution_context_id']]) {
        if (!row[key]) continue;
        const line = document.createElement('span'); line.textContent = `${label}: ${row[key]}`; details.append(line);
      }
      content.append(details);
    }
  }
  customElements.define('record-audit', RecordAudit);
  window.NexoRecordAudit = {
    button(table, id) {
      const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      return `<button type="button" data-record-audit-table="${escape(table)}" data-record-audit-id="${escape(id)}">Autoría</button>`;
    },
    show(table, id, selector = 'main') {
      const container = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (!container) return;
      let panel = [...container.children].find(child => child.tagName === 'RECORD-AUDIT');
      if (!panel) { panel = document.createElement('record-audit'); container.prepend(panel); }
      panel.setAttribute('table', table); panel.setAttribute('record-id', id == null ? '' : String(id));
    },
    refresh() { document.querySelectorAll('record-audit').forEach(panel => panel.schedule()); }
  };
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-record-audit-table]');
    if (!button) return;
    event.preventDefault();
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:min(680px,90vw);border:1px solid #d6e4e8;border-radius:10px;padding:20px';
    const title = document.createElement('h2'); title.textContent = 'Autoría del registro'; title.style.cssText = 'font:18px Arial,sans-serif';
    const body = document.createElement('div'), close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Cerrar'; close.onclick = () => dialog.close();
    dialog.append(title, body, close); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    window.NexoRecordAudit.show(button.dataset.recordAuditTable, button.dataset.recordAuditId, body);
    dialog.showModal();
  });
  const page = location.pathname.split('/').pop(), query = new URLSearchParams(location.search);
  const pages = {
    'supplier-invoice-view.html': 'supplier_invoice', 'supplier-invoice-entry.html': 'supplier_invoice',
    'sales-invoice-view.html': 'invoice', 'sales-invoice-entry.html': 'invoice',
    'journal-view.html': 'journal', 'journal-entry.html': 'journal',
    'purchase-document-view.html': 'purchase_document', 'sales-document-view.html': 'sales_document',
    'supplier-payment-view.html': 'supplier_payment', 'customer-payment-view.html': 'customer_payment',
    'bank-check-view.html': 'bank_check', 'bank-check-entry.html': 'bank_check',
    'bank-deposit-view.html': 'bank_deposit', 'bank-deposit-entry.html': 'bank_deposit',
    'bank-fee-view.html': 'bank_fee', 'fixed-asset-view.html': 'asset', 'pdf-template-builder.html': 'pdf_templates'
  };
  if (/^(supplier|sales)-note-(view|entry)\.html$/.test(page)) {
    pages[page] = (page.startsWith('supplier') ? 'supplier_' : '') + (query.get('kind') === 'DEBIT' ? 'debit_note' : 'credit_note');
  }
  let id = query.get('id');
  if (!id && page === 'journal-entry.html') id = sessionStorage.getItem('nexo_edit_journal');
  if (!id && (page === 'supplier-invoice-view.html' || (page === 'supplier-invoice-entry.html' && query.get('view') === '1'))) id = sessionStorage.getItem('nexo_view_supplier_invoice');
  const auditLivesInListAction = page === 'journal-entry.html';
  if (pages[page] && !auditLivesInListAction) document.addEventListener('DOMContentLoaded', () => window.NexoRecordAudit.show(pages[page], id, document.querySelector('main') || document.body), { once: true });
})();
