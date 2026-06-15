'use strict';
// Patch r-observe-api /app/src/index.js - fix async handler
const fs = require('fs');
let c = fs.readFileSync('/app/src/index.js', 'utf8');
let changes = 0;

// Fix 1: Make the POST /system/settings handler async
{
  const old = `app.post(\`\${BASE}/system/settings\`, requireAuth, requireAdmin, (req, res) => {`;
  const nxt = `app.post(\`\${BASE}/system/settings\`, requireAuth, requireAdmin, async (req, res) => {`;
  if (c.includes(old) && !c.includes('async (req, res)')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[1] Made settings POST handler async');
  } else {
    console.log('[1] Handler already async or pattern not found');
  }
}

fs.writeFileSync('/app/src/index.js', c);
console.log('Total changes:', changes);
console.log('DONE');
