import{coreDictionaryRpc}from'../core-catalogs/core-dictionary.service.js';
export interface Country{id:number;name:string;_revision:string;}
const dto=(r:Record<string,unknown>):Country=>({id:Number(r.country_id),name:String(r.name),_revision:String(r._revision)});
export async function listCountries(auth:string):Promise<Country[]>{return(await coreDictionaryRpc(auth,'core_dictionary_catalog',{p_catalog:'countries'})).map(dto);}
export async function createCountry(auth:string,name:unknown):Promise<Country>{return dto(await coreDictionaryRpc(auth,'save_core_dictionary',{p_catalog:'countries',p_id:null,p_payload:{name}}));}
export async function updateCountry(auth:string,id:number,name:unknown,revision?:unknown):Promise<Country>{return dto(await coreDictionaryRpc(auth,'save_core_dictionary',{p_catalog:'countries',p_id:id,p_payload:{name,_revision:revision??null}}));}
export async function deleteCountry(auth:string,id:number,revision?:unknown):Promise<void>{await coreDictionaryRpc(auth,'delete_core_dictionary',{p_catalog:'countries',p_id:id,p_revision:revision??null});}
