import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.resolve(__dirname, '../js/utils.js');
const code = fs.readFileSync(utilsPath, 'utf8');
// Executa o script clássico em escopo global para expor as funções puras.
new Function(code)();
