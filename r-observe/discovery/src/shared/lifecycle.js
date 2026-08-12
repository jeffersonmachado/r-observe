'use strict';
const fs = require('fs');
const path = require('path');
const candidates = [path.resolve(__dirname, '../../shared/lifecycle.js'), path.resolve(__dirname, '../../../shared/lifecycle.js')];
const modulePath = candidates.find(candidate => fs.existsSync(candidate));
if (!modulePath) throw new Error(`lifecycle.js não encontrado: ${candidates.join(', ')}`);
module.exports = require(modulePath);
