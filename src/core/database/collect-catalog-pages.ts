export type CatalogResponseObserver=(response:Response)=>void;
type Row=Record<string,unknown>;
type LoadPage<T extends Row>=(query:string,init:RequestInit,onResponse:CatalogResponseObserver)=>Promise<T[]>;
const PAGE_SIZE=500;

function incomplete(status=503):never{
  throw Object.assign(new Error('No fue posible cargar el catálogo completo. Reintente la consulta.'),{status});
}
function natural(value:string):number{
  const number=Number(value);if(!Number.isSafeInteger(number)||number<0)incomplete();return number;
}

/** Keep the existing authorized list query and publish only a complete array.
 * Content-Range makes short responses safe even below the requested page size.
 * Without a total, an empty page is the only reliable end of the collection. */
export async function collectCatalogPages<T extends Row>(primaryKey:string,query:string,loadPage:LoadPage<T>):Promise<T[]>{
  const rows:T[]=[],seen=new Set<string>();
  let offset=0,total:number|undefined;
  for(;;){
    let range:string|null=null,responseStatus:number|undefined;
    const separator=query.includes('?')?'&':'?';
    let page:T[];
    try{
      page=await loadPage(`${query}${separator}limit=${PAGE_SIZE}&offset=${offset}`,
        {headers:{Prefer:'count=exact'}},response=>{range=response.headers.get('content-range');responseStatus=response.status;});
    }catch(error){
      const status=responseStatus===401||responseStatus===403?responseStatus:(error as {status?:number})?.status;
      if(status===401||status===403)throw Object.assign(new Error(status===401?'La sesión no es válida.':'El rol activo no puede consultar este catálogo.'),{status});
      if(typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<=599)incomplete(status);
      incomplete();
    }
    if(!Array.isArray(page))incomplete();
    if(range!==null){
      const match=String(range).match(/^(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/);
      if(!match)incomplete();
      if(match[1]!==undefined){
        const start=natural(match[1]),end=natural(match[2]);
        if(start!==offset||end<start||end-start+1!==page.length)incomplete();
      }else if(page.length!==0)incomplete();
      if(match[3]!=='*'){
        const count=natural(match[3]);
        if(total!==undefined&&total!==count)incomplete();
        total=count;
      }
    }
    if(total!==undefined&&(offset+page.length>total||(page.length===0&&offset<total)))incomplete();
    for(const record of page){
      if(record===null||typeof record!=='object'||Array.isArray(record))incomplete();
      const key=record[primaryKey];
      if((typeof key!=='string'&&typeof key!=='number')||String(key).trim()===''
        ||(typeof key==='number'&&!Number.isSafeInteger(key)))incomplete();
      const identity=String(key);if(seen.has(identity))incomplete();seen.add(identity);rows.push(record);
    }
    offset+=page.length;
    if(total!==undefined?offset===total:page.length===0)return rows;
  }
}
