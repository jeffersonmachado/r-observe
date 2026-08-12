'use strict';
const fs = require('fs');
const path = require('path');
const candidates = [path.resolve(__dirname, '../../shared/ai-models.js'), path.resolve(__dirname, '../../../shared/ai-models.js')];
const modulePath = candidates.find(candidate => fs.existsSync(candidate));
if (!modulePath) throw new Error(`ai-models.js não encontrado: ${candidates.join(', ')}`);
module.exports = require(modulePath);
