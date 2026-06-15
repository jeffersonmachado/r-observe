const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// 1. Replace Docker projects text input with select multiple
{
  const old = `el.appendChild(h('div',{className:'field'},[h('label',{},'Projetos Docker monitorados'),h('input',{type:'text',id:'txt-docker_projects',value:'',placeholder:'infra,infra-mail',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));`;
  const nxt = `el.appendChild(h('div',{className:'field'},[h('label',{},'Projetos Docker monitorados'),h('select',{id:'sel-docker_projects',multiple:'',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-height:100px',onchange:'markDirty()'},[h('option',{value:'infra'},'infra'),h('option',{value:'infra-httpd'},'infra-httpd'),h('option',{value:'infra-mail'},'infra-mail'),h('option',{value:'dns-consolidated'},'dns-consolidated'),h('option',{value:'edge-sni'},'edge-sni'),h('option',{value:'r-observe'},'r-observe')])]));`;
  if (c.includes(old)) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[1] Docker projects -> select multiple');
  }
}

// 2. Replace Docker ignore containers text input with select multiple
{
  const old = `el.appendChild(h('div',{className:'field'},[h('label',{},'Contêineres ignorados'),h('input',{type:'text',id:'txt-docker_ignore',value:'',placeholder:'bootstrap,certs',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));`;
  const nxt = `el.appendChild(h('div',{className:'field'},[h('label',{},'Contêineres ignorados'),h('select',{id:'sel-docker_ignore',multiple:'',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-height:100px',onchange:'markDirty()'},[h('option',{value:'results-mail-certs-bootstrap'},'results-mail-certs-bootstrap'),h('option',{value:'results-mail-certs'},'results-mail-certs'),h('option',{value:'portainer'},'portainer'),h('option',{value:'librenms'},'librenms')])]));`;
  if (c.includes(old)) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[2] Docker ignore -> select multiple');
  }
}

// 3. Update readCurrentSettings to read from select elements
{
  const old = `      docker_projects: document.getElementById('txt-docker_projects')?.value || '',`;
  const nxt = `      docker_projects: Array.from(document.getElementById('sel-docker_projects')?.selectedOptions||[]).map(o=>o.value).join(','),`;
  if (c.includes(old)) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[3] readCurrentSettings docker_projects from select');
  }
}

{
  const old = `      docker_ignore_containers: document.getElementById('txt-docker_ignore')?.value || '',`;
  const nxt = `      docker_ignore_containers: Array.from(document.getElementById('sel-docker_ignore')?.selectedOptions||[]).map(o=>o.value).join(','),`;
  if (c.includes(old)) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[4] readCurrentSettings docker_ignore from select');
  }
}

fs.writeFileSync(file, c);
console.log('Total changes:', changes);
console.log('DONE');
