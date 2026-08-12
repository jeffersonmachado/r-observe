'use strict';
const fs = require('fs');
const path = require('path');
const candidates = [path.resolve(__dirname, '../../shared/http-error-handler.js'), path.resolve(__dirname, '../../../shared/http-error-handler.js')];
const modulePath = candidates.find(candidate => fs.existsSync(candidate));
if (!modulePath) throw new Error(`http-error-handler.js não encontrado: ${candidates.join(', ')}`);
module.exports = require(modulePath);
