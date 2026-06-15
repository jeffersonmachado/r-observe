'use strict';
// Patch production r-observe-api: fix h() to handle array children recursively
const fs = require('fs');
let c = fs.readFileSync('/app/src/index.js', 'utf8');
let changes = 0;

// Fix h() - add array recursion via walk()
{
  const old = `  children.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c instanceof Node) el.appendChild(c); });`;
  const nxt = `  (function walk(arr){ arr.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c instanceof Node) el.appendChild(c); else if (Array.isArray(c)) walk(c); }); })(children);`;
  if (c.includes(old) && !c.includes('Array.isArray')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[1] h() array recursion fix applied');
  } else if (c.includes('Array.isArray')) {
    console.log('[1] h() already has array recursion');
  } else {
    console.log('[1] h() pattern not found, looking...');
    // Find the actual h function
    const idx = c.indexOf('function h(tag, attrs');
    if (idx >= 0) console.log(' h() at offset:', idx, '\n', c.substring(idx, idx+300));
  }
}

// Fix setSessionCookie - ensure SESSION_COOKIE passed as name
// Check if the fix is correct
{
  const bad = 'setSessionCookie(req, res, result.token, expiresAt)';
  const good = 'setSessionCookie(req, res, SESSION_COOKIE, result.token, expiresAt)';
  if (c.includes(bad)) {
    c = c.replace(bad, good);
    changes++;
    console.log('[2] setSessionCookie fix applied');
  } else {
    console.log('[2] setSessionCookie OK or different pattern');
  }
}

// Fix authenticateRequest  
{
  const bad = 'const auth = await authenticateRequest(req);';
  const good = 'const auth = await authenticateRequest(req, db, SESSION_COOKIE);';
  if (c.includes(bad)) {
    c = c.replace(bad, good);
    changes++;
    console.log('[3] authenticateRequest fix applied');
  } else {
    console.log('[3] authenticateRequest OK');
  }
}

fs.writeFileSync('/app/src/index.js', c);
console.log('Total changes:', changes);
console.log('DONE');
