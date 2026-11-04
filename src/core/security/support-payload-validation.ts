import {Buffer} from 'node:buffer';

export const SUPPORT_FILE_MAX_BYTES=5*1024*1024;
export const SUPPORT_COLLECTION_MAX_BYTES=6*1024*1024;
export const SUPPORT_COLLECTION_MAX_COUNT=20;
const maxEncodedBytes=Math.ceil(SUPPORT_FILE_MAX_BYTES/3)*4;
const maxMimeLength=127;
const allowedMime=/^(?:application\/(?:pdf|octet-stream|zip|xml|msword|vnd\.[a-z0-9.+-]+)|image\/(?:png|jpeg|gif|webp|bmp)|text\/(?:plain|csv|xml))$/;
const controls=/[\u0000-\u001f\u007f-\u009f]/;

type ValidationCode='INVALID_SUPPORT'|'INVALID_METADATA'|'INVALID_FILE'|'INVALID_LINK'|'SUPPORT_LIMIT_EXCEEDED';
export class SupportPayloadValidationError extends Error{
 readonly status:400|413;
 constructor(readonly code:ValidationCode,status:400|413=400){
  super(status===413?'Los respaldos superan el límite permitido.':'El respaldo no es válido.');
  this.name='SupportPayloadValidationError';this.status=status;
 }
}
export interface NewJournalFileSupport{
 support_type:'Archivo';display_name:string;file_name:string;mime_type:string;file_size:number;file_data:string;
}
export interface NewJournalLinkSupport{
 support_type:'Enlace';display_name:string;support_url:string;
}
export type NewJournalSupport=NewJournalFileSupport|NewJournalLinkSupport;
function invalid(code:ValidationCode):never{throw new SupportPayloadValidationError(code);}
function tooLarge():never{throw new SupportPayloadValidationError('SUPPORT_LIMIT_EXCEEDED',413);}
function record(input:unknown):Record<string,unknown>{
 if(input===null||typeof input!=='object'||Array.isArray(input))return invalid('INVALID_SUPPORT');
 const prototype=Object.getPrototypeOf(input);
 if(prototype!==Object.prototype&&prototype!==null)return invalid('INVALID_SUPPORT');
 // Request JSON has data properties. Do not invoke conversion hooks or accessors.
 for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(input)))if(!('value'in descriptor))return invalid('INVALID_SUPPORT');
 if(Object.hasOwn(input,'support_id'))return invalid('INVALID_SUPPORT');
 return input as Record<string,unknown>;
}
function label(value:unknown,maximum:number,fileName=false):string{
 if(typeof value!=='string'||value.length>maximum||controls.test(value))return invalid('INVALID_METADATA');
 const result=value.trim();
 if(!result||(fileName&&(/[\\/]/.test(result)||result==='.'||result==='..')))return invalid('INVALID_METADATA');
 return result;
}
function empty(value:unknown){return value===undefined||value===null||(typeof value==='string'&&value.trim()==='');}
function declaredSize(value:unknown):number{
 if(typeof value==='number'){
  if(!Number.isSafeInteger(value)||value<1)return invalid('INVALID_METADATA');
  if(value>SUPPORT_FILE_MAX_BYTES)return tooLarge();
  return value;
 }
 if(typeof value!=='string'||!value.length||value[0]==='0'||/[^0-9]/.test(value))return invalid('INVALID_METADATA');
 if(value.length>7)return tooLarge();
 const size=Number(value);
 if(size>SUPPORT_FILE_MAX_BYTES)return tooLarge();
 return size;
}
function mime(value:unknown):string{
 if(typeof value==='string'&&controls.test(value))return invalid('INVALID_METADATA');
 if(empty(value))return'';
 if(typeof value!=='string'||value.length>maxMimeLength)return invalid('INVALID_METADATA');
 const result=value.trim().toLowerCase();
 if(!allowedMime.test(result))return invalid('INVALID_FILE');
 return result;
}
function base64Bytes(encoded:string):number{
 if(encoded.length===0||encoded.length%4!==0)return invalid('INVALID_FILE');
 const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
 for(let index=0;index<encoded.length-padding;index++){
  const code=encoded.charCodeAt(index);
  if(!((code>=65&&code<=90)||(code>=97&&code<=122)||(code>=48&&code<=57)||code===43||code===47))return invalid('INVALID_FILE');
 }
 return encoded.length/4*3-padding;
}
function matchesFileFamily(type:string,fileName:string,bytes:Buffer){
 const dot=fileName.lastIndexOf('.'),extension=dot>0?fileName.slice(dot+1).toLowerCase():'';
 const starts=(signature:number[])=>signature.every((value,index)=>bytes[index]===value);
 const text=(offset:number,length:number)=>bytes.toString('latin1',offset,offset+length);
 let valid=true;
 switch(type){
  case'application/pdf':valid=extension==='pdf'&&text(0,5)==='%PDF-';break;
  case'image/png':valid=extension==='png'&&starts([137,80,78,71,13,10,26,10]);break;
  case'image/jpeg':valid=['jpg','jpeg'].includes(extension)&&starts([255,216,255]);break;
  case'image/gif':valid=extension==='gif'&&['GIF87a','GIF89a'].includes(text(0,6));break;
  case'image/webp':valid=extension==='webp'&&text(0,4)==='RIFF'&&text(8,4)==='WEBP';break;
  case'image/bmp':valid=extension==='bmp'&&text(0,2)==='BM';break;
 }
 if(!valid)return invalid('INVALID_FILE');
}
function validate(input:unknown,remainingBytes:number):NewJournalSupport{
 const item=record(input),display_name=label(item.display_name,250);
 if(item.support_type==='Enlace'){
  for(const key of['file_name','mime_type','file_size','file_data'])if(!empty(item[key]))return invalid('INVALID_LINK');
  if(typeof item.support_url!=='string'||item.support_url.length>2048||!/^https:\/\//i.test(item.support_url)||/[\s\u0000-\u0020\u007f-\u009f\\]/.test(item.support_url))return invalid('INVALID_LINK');
  let url:URL;
  try{url=new URL(item.support_url);}catch{return invalid('INVALID_LINK');}
  const authority=item.support_url.slice(item.support_url.indexOf('//')+2).split(/[/?#]/,1)[0];
  if(url.protocol!=='https:'||!url.hostname||!authority||url.username||url.password||authority.includes('@')||url.href.length>2048)return invalid('INVALID_LINK');
  return{support_type:'Enlace',display_name,support_url:url.href};
 }
 if(item.support_type!=='Archivo')return invalid('INVALID_SUPPORT');
 if(!empty(item.support_url))return invalid('INVALID_FILE');
 const file_name=label(item.file_name,255,true),file_size=declaredSize(item.file_size),metadataMime=mime(item.mime_type);
 if(typeof item.file_data!=='string')return invalid('INVALID_FILE');
 // Bound both the encoded payload and its header before slicing or allocating bytes.
 if(item.file_data.length>maxEncodedBytes+maxMimeLength+13)return tooLarge();
 const comma=item.file_data.indexOf(',');
 if(comma<0||comma>maxMimeLength+12)return invalid('INVALID_FILE');
 const header=/^data:([a-z0-9.+\/-]*);base64$/i.exec(item.file_data.slice(0,comma));
 if(!header||header[0].length!==comma)return invalid('INVALID_FILE');
 const dataMime=mime(header[1]);
 if(dataMime!==metadataMime)return invalid('INVALID_FILE');
 const mime_type=dataMime||'application/octet-stream',encoded=item.file_data.slice(comma+1);
 if(encoded.length>maxEncodedBytes)return tooLarge();
 const actualSize=base64Bytes(encoded);
 if(actualSize>SUPPORT_FILE_MAX_BYTES||actualSize>remainingBytes)return tooLarge();
 if(actualSize<1||actualSize!==file_size)return invalid('INVALID_FILE');
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length!==actualSize||bytes.toString('base64')!==encoded)return invalid('INVALID_FILE');
 matchesFileFamily(mime_type,file_name,bytes);
 return{support_type:'Archivo',display_name,file_name,mime_type,file_size:actualSize,file_data:`data:${mime_type};base64,${encoded}`};
}

/** Validate a NEW journal-support write only, after the caller's authorization.
 * Historical reads/references, journal ownership and direct Data API writes are
 * outside this pure helper. PDF/raster signatures are preliminary checks;
 * opaque/Office/ZIP/XML/text downloads are not parsed or scanned for malware.
 */
export function validateNewJournalSupport(input:unknown):NewJournalSupport{
 return validate(input,SUPPORT_FILE_MAX_BYTES);
}
/** New items only; never use a client support_id to bypass file validation.
 * The caller retains its HTTP body bound. This budget covers this collection,
 * not the accumulated supports of a journal across independent requests.
 */
export function validateNewJournalSupports(input:unknown):NewJournalSupport[]{
 if(!Array.isArray(input))return invalid('INVALID_SUPPORT');
 if(input.length>SUPPORT_COLLECTION_MAX_COUNT)return tooLarge();
 let remaining=SUPPORT_COLLECTION_MAX_BYTES;
 const results:NewJournalSupport[]=[];
 for(const item of input){const result=validate(item,remaining);if(result.support_type==='Archivo')remaining-=result.file_size;results.push(result);}
 return results;
}
