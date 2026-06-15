'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Run Nmap -sV on specific ports of a host.
 * Returns parsed service info with versions.
 * 
 * @param {string} host - IP or hostname
 * @param {number[]} ports - Array of port numbers
 * @returns {object[]} - [{port, protocol, service, product, version}]
 */
async function nmapServiceScan(host, ports = []) {
  if (!ports || ports.length === 0) return [];
  
  const portList = ports.join(',');
  const cmd = `nmap -sV -p ${portList} -T4 --version-intensity 5 ${host} 2>/dev/null`;
  
  try {
    const { stdout } = await execAsync(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 });
    return parseNmapOutput(stdout);
  } catch (e) {
    return [];
  }
}

function parseNmapOutput(stdout) {
  const results = [];
  const lines = (stdout || '').split('\n');
  
  for (const line of lines) {
    // Match: "22/tcp   open  ssh     OpenSSH 9.9 (protocol 2.0)"
    const match = line.match(/^(\d+)\/(tcp|udp)\s+(\S+)\s+(\S[\s\S]+?)$/);
    if (!match) continue;
    
    const port = parseInt(match[1], 10);
    const protocol = match[2];
    const state = match[3];
    const serviceLine = match[4].trim();
    
    if (state !== 'open') continue;
    
    // Parse service + product + version from the service line
    // Format: "ssh     OpenSSH 9.9 (protocol 2.0)"
    //         "http   Node.js Express framework"
    //         "domain PowerDNS Recursor 5.1.10"
    const parts = serviceLine.split(/\s{2,}/); // split on 2+ spaces
    const service = parts[0] || 'unknown';
    const productLine = parts[1] || '';
    
    let product = productLine;
    let version = null;
    
    // Extract version: try to find version number pattern
    const versionMatch = productLine.match(/(\d+\.\d+(?:\.\d+)?(?:[a-z]?\d*)?)/);
    if (versionMatch) {
      version = versionMatch[1];
    }
    
    results.push({
      port,
      protocol,
      service,
      product: productLine || null,
      version,
      raw: line.trim()
    });
  }
  
  return results;
}

module.exports = { nmapServiceScan, parseNmapOutput };
