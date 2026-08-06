import { createApp } from '/assets/vue.js';

const icons = {
  core: '<svg viewBox="0 0 24 24"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z M4 7l8 4 8-4 M12 11v10"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z"/></svg>',
  building: '<svg viewBox="0 0 24 24"><path d="M4 21h16M6 21V5h8v16M14 9h4v12M9 8h2M9 12h2M9 16h2"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7 2-.7Z"/></svg>',
  ledger: '<svg viewBox="0 0 24 24"><path d="M5 3h14v18H5zM9 3v18M12 8h4M12 12h4M12 16h3"/></svg>',
  bank: '<svg viewBox="0 0 24 24"><path d="m3 9 9-5 9 5M5 10v7M9 10v7M15 10v7M19 10v7M3 20h18"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><path d="M4 6h15v14H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13M15 11h6v5h-6a2.5 2.5 0 0 1 0-5Z"/></svg>',
  users: '<svg viewBox="0 0 24 24"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-2a6 6 0 0 1 12 0v2M16 11a3 3 0 1 0 0-6M16 15a5 5 0 0 1 5 5v1"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="m4 7 8-4 8 4-8 4-8-4ZM4 7v10l8 4 8-4V7M12 11v10"/></svg>',
  cart: '<svg viewBox="0 0 24 24"><path d="M3 4h2l2 11h11l2-7H6M9 20h.01M18 20h.01"/></svg>',
  flow: '<svg viewBox="0 0 24 24"><path d="M6 3v12a3 3 0 0 0 3 3h9M14 14l4 4-4 4M6 7h8M11 4l3 3-3 3"/></svg>',
  receipt: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6M9 16h4"/></svg>',
  asset: '<svg viewBox="0 0 24 24"><path d="M4 20V9l8-6 8 6v11H4ZM9 20v-6h6v6"/></svg>',
  project: '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v11H3V7ZM3 7V5h7l2 2"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6V3ZM14 3v5h4M9 12h6M9 16h6"/></svg>',
  audit: '<svg viewBox="0 0 24 24"><path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 12l2 2 5-5M8 18h7"/></svg>',
  api: '<svg viewBox="0 0 24 24"><path d="M8 9 4 12l4 3M16 9l4 3-4 3M14 5l-4 14"/></svg>',
  consolidate: '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM9 14h6v6H9zM7 10v2a5 5 0 0 0 5 5M17 10v2a5 5 0 0 1-5 5"/></svg>',
  ai: '<svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M12 8l1.2 2.8L16 12l-2.8 1.2L12 16l-1.2-2.8L8 12l2.8-1.2L12 8Z"/></svg>'
};

const catalogs = [
  { slug:'countries', title:'Países', singular:'país', primaryKey:'country_id', description:'Catálogo de países del sistema', fields:[{key:'country_code_iso2',label:'Código ISO 2',type:'text'},{key:'country_code_iso3',label:'Código ISO 3',type:'text'},{key:'name',label:'Nombre',type:'text',required:true},{key:'phone_code',label:'Código telefónico',type:'text'}] },
  { slug:'languages', title:'Idiomas', singular:'idioma', primaryKey:'language_id', description:'Idiomas soportados por la plataforma', fields:[{key:'code',label:'Código',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'is_active',label:'Activo',type:'boolean'}] },
  { slug:'timezones', title:'Zonas horarias', singular:'zona horaria', primaryKey:'timezone_id', description:'Zonas horarias configurables', fields:[{key:'name',label:'Nombre',type:'text',required:true},{key:'utc_offset',label:'Diferencia UTC',type:'text',required:true},{key:'is_active',label:'Activo',type:'boolean'}] },
  { slug:'currencies', title:'Monedas', singular:'moneda', primaryKey:'currency_id', description:'Catálogo maestro de monedas', fields:[{key:'currency_code',label:'Código',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'symbol',label:'Símbolo',type:'text',required:true},{key:'fx_rate_precision',label:'Precisión cambiaria',type:'number',required:true}] },
  { slug:'status', title:'Estados', singular:'estado', primaryKey:'status_id', description:'Estados maestros del sistema', fields:[{key:'code',label:'Código',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'module',label:'Módulo',type:'text',required:true},{key:'description',label:'Descripción',type:'text'}] },
  { slug:'number-sequences', title:'Secuencias numéricas', singular:'secuencia', primaryKey:'sequence_id', description:'Secuencias numéricas autonumerables', fields:[{key:'prefix',label:'Prefijo',type:'text'},{key:'suffix',label:'Sufijo',type:'text'},{key:'current_number',label:'Número actual',type:'number',required:true},{key:'padding_length',label:'Longitud',type:'number',required:true}] },
  { slug:'transaction-types', title:'Tipos de transacción', singular:'tipo de transacción', primaryKey:'transaction_type_id', description:'Tipos de transacciones del motor ERP', fields:[{key:'code',label:'Código',type:'text',required:true},{key:'name',label:'Nombre',type:'text',required:true},{key:'module_category',label:'Categoría de módulo',type:'text',required:true}] },
  { slug:'parameters', title:'Parámetros', singular:'parámetro', primaryKey:'parameter_id', description:'Parámetros globales del sistema', fields:[{key:'parameter_key',label:'Clave',type:'text',required:true},{key:'parameter_value',label:'Valor',type:'text'},{key:'description',label:'Descripción',type:'text'}] },
  { slug:'settings', title:'Configuraciones', singular:'configuración', primaryKey:'setting_id', description:'Configuraciones del sistema', fields:[{key:'setting_key',label:'Clave',type:'text',required:true},{key:'setting_value',label:'Valor',type:'text'},{key:'scope',label:'Alcance',type:'text',required:true}] }
];

const modules = [
  { name: 'CORE', icon: icons.core, children: catalogs.map(catalog => catalog.title) }, { name: 'Seguridad', icon: icons.shield },
  { name: 'Organización', icon: icons.building }, { name: 'Configuración', icon: icons.settings },
  { name: 'Contabilidad', icon: icons.ledger }, { name: 'Bancos', icon: icons.bank },
  { name: 'Tesorería', icon: icons.wallet }, { name: 'Entidades', icon: icons.users },
  { name: 'Inventario', icon: icons.box }, { name: 'Ventas', icon: icons.cart },
  { name: 'Motor Transacciones', icon: icons.flow }, { name: 'Compras', icon: icons.cart },
  { name: 'Gastos', icon: icons.receipt }, { name: 'Activos Fijos', icon: icons.asset },
  { name: 'Workflow', icon: icons.flow },
  { name: 'Documentos', icon: icons.doc }, { name: 'Auditoría', icon: icons.audit },
  { name: 'API', icon: icons.api }, { name: 'Consolidación', icon: icons.consolidate }, { name: 'IA', icon: icons.ai }
];

createApp({
  data: () => ({ email:'', password:'', showPassword:false, isSubmitting:false, formError:'', authenticated:false, sidebarOpen:false, modules, catalogs, expandedModules:['CORE'], currentModule:'CORE', currentSection:'Países', userName:'equipo', search:'', rows:[], tableError:'', tableLoading:false, dialogSaving:false, dialogError:'', recordDialog:{open:false,mode:'form',id:null,values:{},label:''} }),
  computed: {
    activeCatalog() { return this.catalogs.find(catalog => catalog.title === this.currentSection) ?? null; },
    filteredRows() { const term=this.search.trim().toLocaleLowerCase('es'); return term ? this.rows.filter(row => Object.values(row).some(value => String(value ?? '').toLocaleLowerCase('es').includes(term))) : this.rows; },
    userInitial() { return this.userName.charAt(0).toUpperCase(); },
    activeModuleIcon() { return this.modules.find(module => module.name === this.currentModule)?.icon ?? icons.core; }
  },
  methods: {
    async signIn() { this.formError=''; this.isSubmitting=true; try { const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:this.email,password:this.password})}); const data=await response.json(); if(!response.ok) throw new Error(data.error?.message||'No fue posible iniciar sesión.'); sessionStorage.setItem('nexo_token',data.accessToken); this.userName=data.user.name; this.authenticated=true; await this.loadCatalog(); } catch(cause){this.formError=cause instanceof Error?cause.message:'No fue posible iniciar sesión.';} finally{this.isSubmitting=false;} },
    async api(path,init={}) { const response=await fetch(path,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{}),Authorization:`Bearer ${sessionStorage.getItem('nexo_token')}`,...(init.headers??{})}}); const data=await response.json(); if(!response.ok) throw new Error(data.error?.message||'No fue posible completar la operación.'); return data; },
    async loadCatalog() { if(!this.activeCatalog)return; this.tableLoading=true; this.tableError=''; try{this.rows=await this.api(`/api/core/${this.activeCatalog.slug}`);}catch(cause){this.tableError=cause instanceof Error?cause.message:'No fue posible consultar el catálogo.';}finally{this.tableLoading=false;} },
    selectModule(module) { this.currentModule=module.name; this.currentSection=module.name; this.search=''; if(module.children){const index=this.expandedModules.indexOf(module.name); if(index>=0)this.expandedModules.splice(index,1);else this.expandedModules.push(module.name);} this.sidebarOpen=false; },
    navigateChild(module,child) { this.currentModule=module; this.currentSection=child; this.search=''; this.rows=[]; this.sidebarOpen=false; void this.loadCatalog(); },
    displayValue(field,value) { if(field.type==='boolean') return value?'Sí':'No'; return value??'—'; },
    recordLabel(row) { const field=this.activeCatalog.fields.find(item=>item.key==='name')??this.activeCatalog.fields[0]; return String(row[field.key]??`#${row[this.activeCatalog.primaryKey]}`); },
    openRecordForm(row=null) { const values={}; for(const field of this.activeCatalog.fields) values[field.key]=row?.[field.key]??(field.type==='boolean'?true:''); this.dialogError=''; this.recordDialog={open:true,mode:'form',id:row?.[this.activeCatalog.primaryKey]??null,values,label:row?this.recordLabel(row):''}; },
    requestDelete(row) { this.dialogError=''; this.recordDialog={open:true,mode:'delete',id:row[this.activeCatalog.primaryKey],values:{},label:this.recordLabel(row)}; },
    closeRecordDialog() { if(!this.dialogSaving)this.recordDialog.open=false; },
    async submitRecord() { this.dialogSaving=true; this.dialogError=''; try{const id=this.recordDialog.id; await this.api(`/api/core/${this.activeCatalog.slug}${id?`/${id}`:''}`,{method:id?'PATCH':'POST',body:JSON.stringify(this.recordDialog.values)}); this.recordDialog.open=false; await this.loadCatalog();}catch(cause){this.dialogError=cause instanceof Error?cause.message:'No fue posible guardar el registro.';}finally{this.dialogSaving=false;} },
    async confirmDelete() { this.dialogSaving=true; this.dialogError=''; try{await this.api(`/api/core/${this.activeCatalog.slug}/${this.recordDialog.id}`,{method:'DELETE'}); this.recordDialog.open=false; await this.loadCatalog();}catch(cause){this.dialogError=cause instanceof Error?cause.message:'No fue posible eliminar el registro.';}finally{this.dialogSaving=false;} },
    logout() { sessionStorage.removeItem('nexo_token'); this.authenticated=false; this.password=''; this.formError=''; this.currentModule='CORE'; this.currentSection='Países'; this.rows=[]; }
  }
}).mount('#app');
