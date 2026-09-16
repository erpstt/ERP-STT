import{readFile,writeFile}from'node:fs/promises';
const decoder=new TextDecoder('windows-1252'),reverse=new Map();
for(let byte=0;byte<256;byte++)reverse.set(decoder.decode(Uint8Array.of(byte)),byte);
for(const file of process.argv.slice(2)){const input=await readFile(file,'utf8'),bytes=[];for(const char of input){const byte=reverse.get(char);if(byte===undefined)throw Error(`No se puede reconstruir ${JSON.stringify(char)} en ${file}`);bytes.push(byte);}await writeFile(file,new TextDecoder().decode(Uint8Array.from(bytes)),'utf8');console.log(`UTF-8 restaurado: ${file}`)}
