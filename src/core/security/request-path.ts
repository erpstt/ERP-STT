export function canonicalRequestTarget(target:string|undefined){
 if(!target||!target.startsWith('/')||target.startsWith('//')||target.includes('\\')||/[\x00-\x20\x7f#]/.test(target))throw Object.assign(Error('Ruta de solicitud inválida.'),{status:400});
 const path=target.split('?')[0]!;let decoded:string;try{decoded=decodeURIComponent(path);}catch{throw Object.assign(Error('Ruta de solicitud inválida.'),{status:400});}
 if(decoded!==path||path.includes('//')||path.split('/').some(p=>p==='.'||p==='..'))throw Object.assign(Error('Ruta de solicitud inválida.'),{status:400});
 return target;
}
