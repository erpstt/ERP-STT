import{readFile}from'node:fs/promises';
const[app,index,catalogHtml,catalogJs,matrixHtml,matrixJs,server]=await Promise.all(['../public/app.js','../public/index.html','../public/permission-catalog.html','../public/permission-catalog.js','../public/role-access-matrix.html','../public/role-access-matrix.js','../src/server.ts'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
const checks=[
 [app.includes("slug:'permissions',table:'permissions',title:'Permisos',singular:'permiso',primaryKey:'permission_id',allowCreate:false,allowEdit:false,allowDelete:false"),'El catálogo genérico no está marcado como solo lectura.'],
 [app.includes("openWorkspace('/permission-catalog.html')"),'La opción Permisos no abre el catálogo dedicado.'],
 [index.includes("canCurrentAction('delete')&&activeCatalog.allowDelete !== false"),'El botón Eliminar no respeta allowDelete.'],
 [catalogHtml.includes('Catálogo técnico de permisos')&&!/Editar|Eliminar/.test(catalogHtml),'La pantalla técnica expone acciones de edición.'],
 [catalogJs.includes("this.api('/api/security/permissions')")&&catalogJs.includes('is_operational'),'El catálogo no consulta o clasifica los permisos.'],
 [matrixHtml.includes('Acciones especiales')&&matrixJs.includes('specialPermissionIds'),'La matriz no integra las acciones especiales.'],
 [server.includes("['permissions','role-permissions'].includes(securityRoute[1])&&request.method!=='GET'"),'El backend no bloquea mutaciones manuales.']
];
for(const[valid,message]of checks)if(!valid)throw new Error(message);
console.log('OK: catálogo técnico de solo lectura, navegación y acciones especiales integradas.');
