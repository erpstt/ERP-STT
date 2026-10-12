import {createApp} from '/assets/vue.js';

const actionField={view:'canView',create:'canCreate',edit:'canEdit',delete:'canDelete'};

createApp({
  data:()=>({
    loading:true,saving:false,roles:[],modules:[],specialPermissions:[],selectedRoleId:0,loadedRoleId:0,
    administratorRole:false,grants:{},search:'',activeTab:'standard',expanded:new Set(),dirty:false,
    message:'',messageType:'success',actions:[
      {key:'view',label:'Acceso'},{key:'create',label:'Crear'},{key:'edit',label:'Editar'},{key:'delete',label:'Eliminar'}
    ]
  }),
  computed:{
    selectedRole(){return this.roles.find(role=>Number(role.roleId)===Number(this.selectedRoleId));},
    enabledResources(){return Object.values(this.grants).filter(grant=>grant.canView).length;},
    specialEnabled(){return this.administratorRole?this.specialPermissions.length:this.specialPermissions.filter(permission=>permission.enabled).length;},
    filteredModules(){
      const term=this.search.trim().toLocaleLowerCase('es');
      if(!term)return this.modules;
      return this.modules.map(module=>({...module,resources:module.resources.filter(resource=>`${module.name} ${resource.optionName}`.toLocaleLowerCase('es').includes(term))})).filter(module=>module.resources.length);
    },
    filteredSpecialModules(){
      const term=this.search.trim().toLocaleLowerCase('es'),groups=new Map();
      for(const permission of this.specialPermissions){
        if(term&&!`${permission.module} ${permission.description||''} ${permission.code}`.toLocaleLowerCase('es').includes(term))continue;
        if(!groups.has(permission.module))groups.set(permission.module,[]);
        groups.get(permission.module).push(permission);
      }
      return [...groups.entries()].map(([name,permissions])=>({name,permissions}));
    }
  },
  methods:{
    token(){return localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token');},
    device(){return localStorage.getItem('nexo_device_token')||'';},
    async api(path,init={}){
      const response=await fetch(path,{...init,headers:{Authorization:`Bearer ${this.token()}`,'X-Device-Token':this.device(),...(init.body?{'Content-Type':'application/json'}:{}),...(init.headers||{})}});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error?.message||'No fue posible completar la operación.');
      return data;
    },
    hydrate(data){
      this.roles=data.roles||this.roles;this.modules=data.modules||[];this.specialPermissions=(data.specialPermissions||[]).map(item=>({...item,enabled:Boolean(item.enabled)}));
      this.administratorRole=Boolean(data.isAdministratorRole);this.loadedRoleId=Number(data.selectedRoleId||this.selectedRoleId);this.selectedRoleId=this.loadedRoleId;
      const legacy=(data.grants||[]).some(grant=>grant.resourceKey==='legacy:all');this.grants={};
      for(const module of this.modules)for(const resource of module.resources){
        const saved=(data.grants||[]).find(grant=>grant.resourceKey===resource.key);
        this.grants[resource.key]=saved?{...saved}:{resourceKey:resource.key,canView:legacy||this.administratorRole,canCreate:(legacy||this.administratorRole)&&resource.actions.includes('create'),canEdit:(legacy||this.administratorRole)&&resource.actions.includes('edit'),canDelete:(legacy||this.administratorRole)&&resource.actions.includes('delete')};
      }
      this.expanded=new Set(this.modules.map(module=>module.key));this.dirty=false;
    },
    async load(initial=false){
      this.loading=true;this.message='';
      try{
        const query=this.selectedRoleId?`?roleId=${this.selectedRoleId}`:'';const data=await this.api('/api/security/role-access-matrix'+query);
        if(initial){this.roles=data.roles||[];const accounting=this.roles.find(role=>role.name.toLocaleLowerCase('es')==='contabilidad');const desired=Number(accounting?.roleId||data.selectedRoleId||this.roles[0]?.roleId||0);if(desired!==Number(data.selectedRoleId)){this.selectedRoleId=desired;return await this.load(false);}}
        this.hydrate(data);
      }catch(error){this.message=error.message;this.messageType='error';}
      finally{this.loading=false;}
    },
    async loadRole(){
      if(this.dirty&&!confirm('Hay cambios sin guardar. ¿Desea descartarlos y cambiar de rol?')){this.selectedRoleId=this.loadedRoleId;return;}
      await this.load(false);
    },
    toggleModule(key){const next=new Set(this.expanded);next.has(key)?next.delete(key):next.add(key);this.expanded=next;},
    allowed(resource,action){return this.administratorRole||Boolean(this.grants[resource.key]?.[actionField[action]]);},
    changePermission(resource,action,checked){
      const grant=this.grants[resource.key],field=actionField[action];grant[field]=checked;
      if(action==='view'&&!checked){grant.canCreate=false;grant.canEdit=false;grant.canDelete=false;}else if(action!=='view'&&checked)grant.canView=true;
      this.dirty=true;this.message='';
    },
    setModule(module,value){for(const resource of module.resources){const grant=this.grants[resource.key];grant.canView=value;grant.canCreate=value&&resource.actions.includes('create');grant.canEdit=value&&resource.actions.includes('edit');grant.canDelete=value&&resource.actions.includes('delete');}this.dirty=true;},
    toggleSpecial(permission,checked){permission.enabled=checked;this.dirty=true;this.message='';},
    setSpecialModule(module,value){for(const permission of module.permissions)permission.enabled=value;this.dirty=true;},
    specialType(code){
      const value=String(code).toUpperCase();
      if(/APPROVE|APROBAR/.test(value))return'Aprobación';if(/REVERSE|ANULAR|REVERS/.test(value))return'Reversión';
      if(/EXECUTE|EJECUTAR|PROCESAR/.test(value))return'Ejecución';if(/PUBLISH|PUBLICAR/.test(value))return'Publicación';
      if(/LOCK|CERRAR|BLOQUEAR/.test(value))return'Bloqueo o cierre';if(/FILE|SUBIR/.test(value))return'Presentación o archivo';
      if(/VIEW|_VER$|\.VIEW$/.test(value))return'Consulta especializada';if(/CREATE|CREAR/.test(value))return'Creación especializada';
      if(/UPDATE|EDITAR/.test(value))return'Modificación especializada';if(/MANAGE|ADMINISTRAR/.test(value))return'Administración especializada';return'Acción especializada';
    },
    async save(){
      this.saving=true;this.message='';const roleName=this.selectedRole?.name||'seleccionado';
      try{
        await this.api('/api/security/role-access-matrix',{method:'POST',body:JSON.stringify({roleId:this.selectedRoleId,entries:Object.values(this.grants),specialPermissionIds:this.specialPermissions.filter(permission=>permission.enabled).map(permission=>permission.permissionId)})});
        await this.load(false);this.message=`Permisos del rol ${roleName} guardados correctamente.`;this.messageType='success';
      }catch(error){this.message=error.message;this.messageType='error';}
      finally{this.saving=false;}
    }
  },
  mounted(){if(!this.token()){location.href='/';return;}this.load(true);}
}).mount('#matrixApp');
