import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
type Item=Record<string,any>;
const num=(v:unknown)=>Number(v||0),round=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const monthAt=(start:string,offset:number)=>{const date=new Date(start+'T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+offset);return date.toISOString().slice(0,7);};
const sum=(v:number[])=>round(v.reduce((a,b)=>a+b,0));
const dimensions:Record<string,string>={DEPARTMENT:'department_id',CLASS:'class_id',LOCATION:'location_id',COST_CENTER:'cost_center_id',PROJECT:'cost_center_id',SUBSIDIARY:'subsidiary_id'};
export function calculateIncomeForecast(source:Item,p:Item){
 const method=String(p.method||'RUN_RATE'),column=String(p.columnView||'ACCOUNTING_PERIOD'),level=num(p.hierarchy||4),factor=Number(p.inflation||0),overrides=p.overrides||{};
 if(!['BUDGET','RUN_RATE','PRIOR_YEAR'].includes(method)||!['TOTAL','ACCOUNTING_PERIOD',...Object.keys(dimensions)].includes(column))throw Error('Método o columna de proyección inválidos.');
 if(!Number.isFinite(factor)||factor< -100||factor>1000||![1,2,3,4].includes(level))throw Error('Factor de ajuste o nivel de detalle inválidos.');
 if(!overrides||Array.isArray(overrides)||typeof overrides!=='object'||Object.keys(overrides).length>20000)throw Error('Ajustes manuales inválidos.');
 const dimensioned=!!dimensions[column]||['departmentId','departmentType','classId','locationId','costCenterId','projectId'].some(k=>p[k]!==null&&p[k]!==undefined&&p[k]!=='');
 if(method==='BUDGET'&&dimensioned)throw Error('El presupuesto es general por sociedad. Para dimensiones utilice Promedio YTD o Año anterior.');
 const months=Array.from({length:12},(_,i)=>monthAt(source.start,i)),monthIndex=new Map(months.map((month,index)=>[month,index])),priorMonthIndex=new Map(months.map((month,index)=>[`${num(month.slice(0,4))-1}${month.slice(4)}`,index])),k=(monthIndex.get(source.cutoff.slice(0,7))??-1)+1;
 if(k<1)throw Error('El corte no corresponde al ejercicio fiscal.');
 const currencyId=p.currencyId?num(p.currencyId):num(source.companies[0]?.currencyId),currency=source.currencies.find((c:Item)=>num(c.id)===currencyId)?.code;
 if(!currency)throw Error('Seleccione una moneda válida.');
 if(p.consolidated&&currency!=='USD')throw Error('La consolidación con eliminaciones publicadas utiliza USD.');
 if(!p.currencyId&&source.companies.some((c:Item)=>num(c.currencyId)!==currencyId))throw Error('Seleccione una moneda de presentación común para consolidar las sociedades.');
 const accounts=new Map<string,Item>(source.accounts.map((a:Item)=>[String(a.id),a])),companies=new Map<string,Item>(source.companies.map((c:Item)=>[String(c.id),c])),groups=new Map<string,Item>((source.groups||[]).map((g:Item)=>[String(g.id),g]));
 const consolidatedRates=new Map<string,Item>(),marketRates=new Map<string,Array<{date:string;rate:number}>>(),calculatedRates=new Map<string,number>();
 for(const row of source.consolidatedRates||[]){const base=`${row.sid}:${num(row.to)}:${row.month}`;if(!consolidatedRates.has(base))consolidatedRates.set(base,row);if(row.holding!==null&&row.holding!==undefined){const holding=`${base}:${row.holding}`;if(!consolidatedRates.has(holding))consolidatedRates.set(holding,row);}}
 for(const row of source.rates||[]){const from=num(row.from),to=num(row.to),value=num(row.rate),date=String(row.date);for(const [key,rateValue] of [[`${from}:${to}`,value],[`${to}:${from}`,1/value]] as Array<[string,number]>){const values=marketRates.get(key)??[];values.push({date,rate:rateValue});marketRates.set(key,values);}}
 for(const values of marketRates.values())values.sort((a,b)=>b.date.localeCompare(a.date));
 const rateNotes=new Map<string,Item>();
 const rate=(sid:unknown,month:string)=>{
  const company=companies.get(String(sid));if(!company)throw Error('Sociedad fuera del alcance.');
  if(num(company.currencyId)===currencyId)return 1;
  const effective=month>source.cutoff.slice(0,7)?source.cutoff.slice(0,7):month;
   const cacheKey=`${sid}:${effective}`,cached=calculatedRates.get(cacheKey);if(cached!==undefined)return cached;
   const baseKey=`${sid}:${currencyId}:${effective}`,consolidated=consolidatedRates.get(p.holdingId?`${baseKey}:${p.holdingId}`:baseKey);
  let value=currency==='USD'&&consolidated?num(consolidated.rate):0,origin='Promedio consolidado';
   if(!value){const latest=marketRates.get(`${num(company.currencyId)}:${currencyId}`)?.find(entry=>entry.date.slice(0,7)<=effective);value=latest?.rate??0;origin='Último tipo de cambio disponible';}
  if(!Number.isFinite(value)||value<=0)throw Error(`Falta tipo de cambio de ${company.currency} a ${currency} para ${effective} (${company.name}).`);
   calculatedRates.set(cacheKey,value);rateNotes.set(cacheKey,{company:company.name,month:effective,rate:value,source:origin});return value;
 };
 const rows=new Map<string,Item>();
 const ensure=(fact:Item)=>{const a=accounts.get(String(fact.account_id));if(!a)return null;const dim=dimensions[column]?String(fact[dimensions[column]]??'unassigned'):'total',key=`${a.id}:${dim}`;
  if(!rows.has(key))rows.set(key,{key,accountId:a.id,number:a.number,name:a.name,category:a.category,groupId:a.groupId,dimension:dim,real:Array(12).fill(0),prior:Array(12).fill(0),budget:Array(12).fill(0)});return rows.get(key)!;
 };
 for(const fact of source.facts){const r=ensure(fact);if(!r)continue;const factMonth=fact.month.slice(0,7),current=monthIndex.get(factMonth)??-1,previous=priorMonthIndex.get(factMonth)??-1;
  if(current>=0&&current<k)r.real[current]+=num(fact.amount)*(r.category==='Ingreso'?-1:1)*rate(fact.subsidiary_id,months[current]);
  if(method==='PRIOR_YEAR'&&previous>=0)r.prior[previous]+=num(fact.amount)*(r.category==='Ingreso'?-1:1)*rate(fact.subsidiary_id,fact.month.slice(0,7));
 }
 const dimensionFilter=['departmentId','departmentType','classId','locationId','costCenterId','projectId'].some(key=>p[key]!==null&&p[key]!==undefined&&p[key]!=='');
 if(p.consolidated){
  const required=[...months.slice(0,k),...(method==='PRIOR_YEAR'?months.slice(k).map(m=>`${num(m.slice(0,4))-1}${m.slice(4)}`):[])];
  for(const month of required)if(!(source.consolidationMonths||[]).includes(month))throw Error(`Publique la consolidación de ${month} para incluir sus eliminaciones.`);
  if(!dimensionFilter)for(const fact of source.eliminations||[]){const r=ensure({...fact,subsidiary_id:'eliminations'});if(!r)continue;const i=monthIndex.get(fact.month)??-1,prior=priorMonthIndex.get(fact.month)??-1,amount=num(fact.amount)*(r.category==='Ingreso'?-1:1);if(i>=0&&i<k)r.real[i]+=amount;if(method==='PRIOR_YEAR'&&prior>=0)r.prior[prior]+=amount;}
 }
 if(method==='BUDGET'){
  const approvedBudgets=new Set((source.approvedBudgets||[]).map((header:Item)=>`${num(header.sid)}:${num(header.year)}`));
  for(const c of source.companies)for(const year of new Set(months.slice(k).map(m=>num(m.slice(0,4)))))if(!approvedBudgets.has(`${num(c.id)}:${year}`))throw Error(`No hay presupuesto aprobado para ${c.name}, año ${year}.`);
  for(const fact of source.budgets){const r=ensure(fact),i=monthIndex.get(fact.month.slice(0,7))??-1;if(r&&i>=k)r.budget[i]+=num(fact.amount)*rate(fact.subsidiary_id,months[i]);}
 }
 const used=new Set<string>(),detail:Item[]=[];
 for(const r of rows.values()){
  r.real=r.real.map(round);r.prior=r.prior.map(round);r.budget=r.budget.map(round);const average=sum(r.real)/k;
  r.base=months.map((_,i)=>i<k?r.real[i]:round(method==='RUN_RATE'?average:method==='PRIOR_YEAR'?r.prior[i]*(1+factor/100):r.budget[i]));
  r.values=r.base.map((value:number,i:number)=>{const key=`${r.key}:${months[i]}`;if(!Object.hasOwn(overrides,key))return value;if(i<k)throw Error('Los meses reales no se pueden modificar.');const entry=overrides[key],amount=Number(entry?.amount);if(!Number.isFinite(amount)||Math.abs(amount)>1e15||typeof entry?.reason!=='string'||entry.reason.trim().length<5)throw Error('Cada ajuste requiere un importe válido y un motivo de al menos 5 caracteres.');used.add(key);return round(amount);});
  r.ytd=sum(r.values.slice(0,k));r.future=sum(r.values.slice(k));r.annual=sum(r.values);r.adjustment=round(r.annual-sum(r.base));
  if(!p.excludeZero||r.values.some((v:number)=>Math.abs(v)>=.005)||r.adjustment)detail.push(r);
 }
 if(Object.keys(overrides).some(key=>!used.has(key)))throw Error('Existen ajustes que no corresponden a los filtros actuales. Restablezca los ajustes o cargue su escenario original.');
 let display=detail;
 if(level<4){const grouped=new Map<string,Item>();for(const r of detail){let g=groups.get(String(r.groupId)),guard=0;while(g&&num(g.level)>level&&g.parentId&&guard++<20)g=groups.get(String(g.parentId));const key=`g:${g?.id||r.category}:${r.dimension}`;if(!grouped.has(key))grouped.set(key,{key,number:g?.code||'',name:g?.name||r.category,category:r.category,dimension:r.dimension,values:Array(12).fill(0),base:Array(12).fill(0),group:true});const row=grouped.get(key)!;row.values=row.values.map((v:number,i:number)=>round(v+r.values[i]));row.base=row.base.map((v:number,i:number)=>round(v+r.base[i]));}display=[...grouped.values()].map(r=>({...r,ytd:sum(r.values.slice(0,k)),future:sum(r.values.slice(k)),annual:sum(r.values),adjustment:round(sum(r.values)-sum(r.base))}));}
 display.sort((a,b)=>['Ingreso','Costo','Gasto'].indexOf(a.category)-['Ingreso','Costo','Gasto'].indexOf(b.category)||String(a.number).localeCompare(String(b.number),'es',{numeric:true})||a.dimension.localeCompare(b.dimension));
 const summary:Item={Ingreso:Array(12).fill(0),Costo:Array(12).fill(0),Gasto:Array(12).fill(0)};for(const row of detail){const values=summary[row.category];if(!values)continue;for(let i=0;i<12;i++)values[i]+=row.values[i];}for(const cat of ['Ingreso','Costo','Gasto'])summary[cat]=summary[cat].map(round);
 summary.gross=months.map((_,i)=>round(summary.Ingreso[i]-summary.Costo[i]));summary.net=months.map((_,i)=>round(summary.gross[i]-summary.Gasto[i]));
 return{months,k,start:source.start,end:source.end,cutoff:source.cutoff,method,columnView:column,currency,rows:display,summary,totals:{real:sum(summary.net.slice(0,k)),future:sum(summary.net.slice(k)),annual:sum(summary.net)},rates:[...rateNotes.values()],companies:source.companies,notes:[...(method==='BUDGET'?['Se utiliza el presupuesto aprobado más las modificaciones aprobadas, sin distribuirlo por dimensiones.']:[]),'Los meses sin movimientos se incluyen con cero en el divisor del promedio.','Los meses futuros utilizan el tipo de cambio disponible al corte.',...(p.consolidated?[dimensionFilter?'Los filtros dimensionales excluyen las eliminaciones publicadas, que no tienen dimensión asignada.':'Consolidado: Mayor vigente más eliminaciones publicadas. Las eliminaciones se presentan sin dimensión asignada.']:source.companies.length>1?['Vista agregada de sociedades, sin eliminaciones intercompañía. Seleccione Consolidado para incluir las publicadas.']:[])],overrides};
}
async function rpc(auth:string,name:string,p:Item={}){const config=getSupabaseConfig();if(!config)throw Error('Base de datos no configurada.');const res=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(p)});const result=await res.json()as Item;if(!res.ok)throw Error(result.message||'No fue posible procesar la proyección.');return result;}
export async function incomeForecastAction(auth:string,action:string,p:Item){
 if(action==='options')return rpc(auth,'income_forecast_options',{p_consolidated:!!p.consolidated});
 if(action==='generate')return calculateIncomeForecast(await rpc(auth,'income_forecast_source',{p}),p);
 if(action==='save'){calculateIncomeForecast(await rpc(auth,'income_forecast_source',{p:p.configuration}),p.configuration);return rpc(auth,'income_forecast_save',{p});}
 throw Error('Acción de proyección inválida.');
}
