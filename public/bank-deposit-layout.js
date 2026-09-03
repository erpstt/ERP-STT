const lines=document.getElementById('lines');
const referenceInput=[...document.querySelectorAll('.deposit-header input')].find(input=>input.value==='Se asignará al guardar');if(referenceInput){referenceInput.id='bankReference';referenceInput.readOnly=false;referenceInput.value='';referenceInput.placeholder='Ingrese la referencia del banco';const textNode=[...referenceInput.parentElement.childNodes].find(node=>node.nodeType===Node.TEXT_NODE);if(textNode)textNode.textContent='Referencia bancaria'}
function alignNotes(){for(const row of lines?.rows||[]){const note=row.querySelector('[data-key="note"]')?.closest('td');if(note&&row.children[3]!==note)row.insertBefore(note,row.children[3])}}
if(lines){new MutationObserver(alignNotes).observe(lines,{childList:true});alignNotes()}
if(new URLSearchParams(location.search).has('id'))import('./bank-deposit-edit.js');
document.getElementById('accept')?.addEventListener('click',event=>{event.stopImmediatePropagation();location.assign('/bank-deposits.html')},true);
