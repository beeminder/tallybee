import * as beeminder from './beeminder.js';

// Convenience functions -------------------------------------------------------
const CLOG   = console.log
function $(id) { return document.getElementById(id) } // to be jQuery-esque
// -----------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => { // -------- document-ready
}) // ------------------------------------------------------- end document-ready

// Business logic: increment the number when you click the thing
let counter = 0;
$('bigbut').addEventListener('click', () => {
  $('bigbut').innerHTML = ++counter;
  $('num').innerHTML = counter;
});
$('undobut').addEventListener('click', () => {
  $('bigbut').innerHTML = --counter;
  $('num').innerHTML = counter;
});
$('subbut').addEventListener('click', () => {
  if (counter > 0) {
    beeminder.addDatapoint($('goals').value, counter, `via TallyBee at ${new Date()}`);
  }j
  counter = 0;
  $('bigbut').innerHTML = counter;
  $('num').innerHTML = counter;
})