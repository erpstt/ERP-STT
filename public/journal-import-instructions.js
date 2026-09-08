const instructions = document.getElementById('instructionsDialog');
document.getElementById('openInstructions').addEventListener('click', () => instructions.showModal());
instructions.addEventListener('close', () => document.getElementById('openInstructions').focus());
