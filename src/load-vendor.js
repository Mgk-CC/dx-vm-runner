const fs = require('node:fs');
const vm = require('node:vm');

function ensureContext(globalObject) {
  return vm.isContext(globalObject)
    ? globalObject
    : vm.createContext(globalObject, {
        codeGeneration: { strings: false, wasm: false }
      });
}

function runBundle(context, filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return vm.runInContext(source, context, {
    filename: filePath,
    timeout: 30000,
    displayErrors: true
  });
}

function loadGlobalBundle(context, filePath) {
  runBundle(context, filePath);
}

module.exports = {
  ensureContext,
  loadGlobalBundle
};
