'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

function shellEscape(value) {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}

function detectVendor(text) {
  const low = String(text || '').toLowerCase();
  if (low.includes('cisco')) return 'Cisco';
  if (low.includes('mikrotik')) return 'MikroTik';
  if (low.includes('ubiquiti') || low.includes('unifi')) return 'Ubiquiti';
  if (low.includes('hewlett packard') || low.includes(' hp ') || low.includes('procurve')) return 'HP';
  if (low.includes('fortinet') || low.includes('fortigate')) return 'Fortinet';
  if (low.includes('grandstream')) return 'Grandstream';
  if (low.includes('intelbras')) return 'Intelbras';
  if (low.includes('hikvision')) return 'Hikvision';
  if (low.includes('dahua')) return 'Dahua';
  if (low.includes('yealink')) return 'Yealink';
  return null;
}

function parseValue(line) {
  return String(line || '').split('=').slice(1).join('=').trim() || null;
}

function cleanSnmpValue(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  value = value.replace(/^(STRING|INTEGER|Gauge32|Counter32|Counter64|Timeticks|Hex-STRING|OID):\s*/i, '');
  value = value.replace(/^"|"$/g, '').trim();
  return value || null;
}

function parseLineMeta(line) {
  const text = String(line || '').trim();
  const oidMatch = text.match(/^([^\s=]+)\s*=\s*(.+)$/);
  if (!oidMatch) return null;

  const oid = oidMatch[1];
  const valueRaw = oidMatch[2];
  const value = cleanSnmpValue(valueRaw);
  const indexMatch = oid.match(/\.(\d+)$/);
  return {
    oid,
    valueRaw,
    value,
    index: indexMatch ? indexMatch[1] : null,
    text,
  };
}

function extractNamedValue(line, marker) {
  if (!String(line).includes(marker)) return null;
  return parseValue(line);
}

function extractIndex(line) {
  const m = String(line || '').match(/\.([0-9]+)\s*=\s*/);
  return m ? m[1] : null;
}

function parseSnmpOutput(output) {
  const result = {
    sysDescr: null,
    sysName: null,
    sysUptime: null,
    sysContact: null,
    sysLocation: null,
    vendor: null,
    model: null,
    serial: null,
    interfaces: [],
    vlans: [],
    neighbors: [],
    authFailure: false,
    raw: [],
  };

  const ifNames = {};
  const ifDescr = {};
  const ifOper = {};
  const ifAdmin = {};
  const ifSpeed = {};
  const ifMtu = {};
  const ifType = {};
  const ifInErrors = {};
  const ifOutErrors = {};
  const ifHCInOctets = {};
  const ifHCOutOctets = {};
  const vlanNames = [];
  const neighbors = [];
  const serialCandidates = [];
  const modelCandidates = [];

  const lines = String(output || '').split(/\n|\\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    result.raw.push(line);
    const meta = parseLineMeta(line);

    if (/authentication failure|authorization error|usmstats|wrongdigest|unknown user name/i.test(line)) {
      result.authFailure = true;
    }

    if (line.includes('sysDescr') || line.includes('1.3.6.1.2.1.1.1.0')) {
      result.sysDescr = cleanSnmpValue(extractNamedValue(line, 'sysDescr') || parseValue(line)) || result.sysDescr;
      if (result.sysDescr) {
        const vendor = detectVendor(result.sysDescr);
        if (vendor) result.vendor = vendor;
        const modelMatch = result.sysDescr.match(/(?:model|platform|series)\s*[:=]?\s*([a-z0-9_.\/-]+)/i);
        if (modelMatch) modelCandidates.push(modelMatch[1]);
      }
    } else if (line.includes('sysName') || line.includes('1.3.6.1.2.1.1.5.0')) {
      result.sysName = cleanSnmpValue(extractNamedValue(line, 'sysName') || parseValue(line)) || result.sysName;
    } else if (line.includes('sysUpTime') || line.includes('1.3.6.1.2.1.1.3.0')) {
      result.sysUptime = cleanSnmpValue(extractNamedValue(line, 'sysUpTime') || parseValue(line)) || result.sysUptime;
    } else if (line.includes('sysContact') || line.includes('1.3.6.1.2.1.1.4.0')) {
      result.sysContact = cleanSnmpValue(extractNamedValue(line, 'sysContact') || parseValue(line)) || result.sysContact;
    } else if (line.includes('sysLocation') || line.includes('1.3.6.1.2.1.1.6.0')) {
      result.sysLocation = cleanSnmpValue(extractNamedValue(line, 'sysLocation') || parseValue(line)) || result.sysLocation;
    }

    if (/ifName\.|1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.1\./.test(line) && meta?.index) {
      ifNames[meta.index] = meta.value;
    }
    if (/ifDescr\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.2\./.test(line) && meta?.index) {
      ifDescr[meta.index] = meta.value;
    }
    if (/ifOperStatus\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.8\./.test(line) && meta?.index) {
      ifOper[meta.index] = meta.value;
    }
    // ── ifTable completo (camada física L1) ──────────────────────────────
    if (/ifSpeed\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.5\./.test(line) && meta?.index) {
      ifSpeed[meta.index] = meta.value;  // bits per second (Gauge32)
    }
    if (/ifAdminStatus\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.7\./.test(line) && meta?.index) {
      ifAdmin[meta.index] = meta.value;
    }
    if (/ifMtu\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.4\./.test(line) && meta?.index) {
      ifMtu[meta.index] = meta.value;
    }
    if (/ifType\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.3\./.test(line) && meta?.index) {
      ifType[meta.index] = meta.value;
    }
    if (/ifInErrors\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.14\./.test(line) && meta?.index) {
      ifInErrors[meta.index] = meta.value;
    }
    if (/ifOutErrors\.|1\.3\.6\.1\.2\.1\.2\.2\.1\.20\./.test(line) && meta?.index) {
      ifOutErrors[meta.index] = meta.value;
    }
    // ── ifXTable (64-bit counters) ───────────────────────────────────────
    if (/ifHCInOctets\.|1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.6\./.test(line) && meta?.index) {
      ifHCInOctets[meta.index] = meta.value;
    }
    if (/ifHCOutOctets\.|1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.10\./.test(line) && meta?.index) {
      ifHCOutOctets[meta.index] = meta.value;
    }

    if (/dot1qVlanStaticName\.|1\.3\.6\.1\.2\.1\.17\.7\.1\.4\.3\.1\.1\./.test(line)) {
      const val = meta?.value;
      if (val) vlanNames.push(val);
    }

    if (/lldpRemSysName\.|cdpCacheDeviceId\./.test(line)) {
      const val = meta?.value;
      if (val) neighbors.push(val);
    }

    if (/entPhysicalSerialNum\.|serial/i.test(line)) {
      const val = meta?.value || cleanSnmpValue(parseValue(line));
      if (val && !/^"?\s*\"?$/.test(val)) serialCandidates.push(val);
    }
    if (/entPhysicalModelName\.|model/i.test(line)) {
      const val = meta?.value || cleanSnmpValue(parseValue(line));
      if (val && !/^"?\s*\"?$/.test(val)) modelCandidates.push(val);
    }
  }

  const ifIndexes = Array.from(new Set([
    ...Object.keys(ifNames), ...Object.keys(ifDescr), ...Object.keys(ifOper),
    ...Object.keys(ifSpeed), ...Object.keys(ifAdmin), ...Object.keys(ifMtu),
    ...Object.keys(ifType), ...Object.keys(ifInErrors), ...Object.keys(ifOutErrors),
  ])).sort((a, b) => Number(a) - Number(b));

  function parseSpeed(raw) {
    if (!raw) return null;
    const n = Number(raw);
    if (isNaN(n)) return null;
    return n > 0 ? n : null; // 0 = down/disconnected
  }
  function parseIntField(raw) {
    if (!raw) return null;
    const n = Number(raw);
    return isNaN(n) ? null : n;
  }
  function parseAdminStatus(raw) {
    const map = { '1': 'up', '2': 'down', '3': 'testing' };
    return map[String(raw)] || raw || null;
  }
  function parseOperStatus(raw) {
    const map = { '1': 'up', '2': 'down', '3': 'testing', '4': 'unknown',
                  '5': 'dormant', '6': 'notPresent', '7': 'lowerLayerDown' };
    return map[String(raw)] || raw || null;
  }
  function parseIfType(raw) {
    const map = {
      '6': 'ethernetCsmacd', '7': 'ethernet', '23': 'ppp', '24': 'softwareLoopback',
      '53': 'propVirtual', '117': 'gigabitEthernet', '135': 'l2vlan', '136': 'l3ipvlan',
      '161': 'ieee80211', '166': 'mpls', '209': 'bridge', '258': 'opticalChannel',
    };
    return map[String(raw)] || `ifType(${raw})` || null;
  }

  result.interfaces = ifIndexes.map((idx) => ({
    index: Number(idx),
    name: ifNames[idx] || null,
    description: ifDescr[idx] || null,
    type: parseIfType(ifType[idx]),
    mtu: parseIntField(ifMtu[idx]),
    speed_bps: parseSpeed(ifSpeed[idx]),
    admin_status: parseAdminStatus(ifAdmin[idx]),
    oper_status: parseOperStatus(ifOper[idx]),
    in_errors: parseIntField(ifInErrors[idx]),
    out_errors: parseIntField(ifOutErrors[idx]),
    hc_in_octets: parseIntField(ifHCInOctets[idx]),
    hc_out_octets: parseIntField(ifHCOutOctets[idx]),
  }));
  result.vlans = Array.from(new Set(vlanNames));
  result.neighbors = Array.from(new Set(neighbors));
  if (!result.vendor && result.sysName) result.vendor = detectVendor(result.sysName);
  result.model = modelCandidates[0] || null;
  result.serial = serialCandidates[0] || null;

  return result;
}

function buildSnmpCommands(host, options = {}, oid = '1.3.6.1.2.1.1') {
  const timeoutSec = Math.max(1, Math.ceil((options.timeoutMs || 4000) / 1000));
  const version = String(options.version || process.env.DISCOVERY_SNMP_VERSION || '2c').toLowerCase();
  const commands = [];

  if (version === '3') {
    const user = options.user || process.env.DISCOVERY_SNMP_V3_USER;
    if (!user) return [];
    const level = options.securityLevel || process.env.DISCOVERY_SNMP_V3_LEVEL || 'authNoPriv';
    const authProto = options.authProtocol || process.env.DISCOVERY_SNMP_V3_AUTH_PROTO || 'SHA';
    const authPass = options.authPassword || process.env.DISCOVERY_SNMP_V3_AUTH_PASS || '';
    const privProto = options.privProtocol || process.env.DISCOVERY_SNMP_V3_PRIV_PROTO || 'AES';
    const privPass = options.privPassword || process.env.DISCOVERY_SNMP_V3_PRIV_PASS || '';

    const args = [`-v3`, `-l ${level}`, `-u ${shellEscape(user)}`, `-t ${timeoutSec}`, '-r 0'];
    if (level === 'authNoPriv' || level === 'authPriv') {
      if (!authPass) return [];
      args.push(`-a ${authProto}`, `-A ${shellEscape(authPass)}`);
    }
    if (level === 'authPriv') {
      if (!privPass) return [];
      args.push(`-x ${privProto}`, `-X ${shellEscape(privPass)}`);
    }

    const base = `${args.join(' ')} ${shellEscape(host)} ${oid}`;
    commands.push(`snmpbulkwalk ${base}`);
    commands.push(`snmpwalk ${base}`);
    return commands;
  }

  const community = options.community || process.env.DISCOVERY_SNMP_COMMUNITY || 'public';
  const v = version === '1' ? '1' : '2c';
  const base = `-v ${v} -c ${shellEscape(community)} -t ${timeoutSec} -r 0 ${shellEscape(host)} ${oid}`;
  commands.push(`snmpbulkwalk ${base}`);
  commands.push(`snmpwalk ${base}`);
  return commands;
}

async function runSnmpCmd(command, timeoutMs = 4000, execFn = execAsync) {
  const wrapped = `timeout ${Math.max(1, Math.ceil(timeoutMs / 1000))}s ${command}`;
  try {
    const { stdout, stderr } = await execFn(wrapped);
    return { ok: true, stdout: stdout || '', stderr: stderr || '', command: wrapped };
  } catch (e) {
    const failure = {
      ok: false,
      stdout: e?.stdout || '',
      stderr: e?.stderr || e?.message || '',
      code: e?.code,
      command: wrapped,
    };

    // Fallback for environments without GNU timeout.
    if (/timeout: not found|command not found/i.test(failure.stderr)) {
      try {
        const { stdout, stderr } = await execFn(command, { timeout: timeoutMs });
        return { ok: true, stdout: stdout || '', stderr: stderr || '', command };
      } catch (inner) {
        return {
          ok: false,
          stdout: inner?.stdout || '',
          stderr: inner?.stderr || inner?.message || '',
          code: inner?.code,
          command,
        };
      }
    }

    return failure;
  }
}

async function probeSnmpTarget(host, options = {}) {
  const timeoutMs = options.timeoutMs || 4000;
  const retries = Math.max(0, Number.isInteger(options.retries) ? options.retries : 1);
  const physicalLayerEnabled = options.physical_layer !== false;

  // OIDs para walk: system + ifTable + ifXTable
  const oidSets = [
    { oid: '1.3.6.1.2.1.1',       label: 'system' },      // sysDescr, sysName, etc.
  ];
  if (physicalLayerEnabled) {
    oidSets.push(
      { oid: '1.3.6.1.2.1.2.2.1',   label: 'ifTable' },    // ifIndex, ifDescr, ifSpeed, ifOperStatus, etc.
      { oid: '1.3.6.1.2.1.31.1.1.1', label: 'ifXTable' },   // ifName, ifHCInOctets, ifHCOutOctets (64-bit)
    );
  }

  const merged = {
    sysDescr: null, sysName: null, sysUptime: null, sysContact: null,
    sysLocation: null, vendor: null, model: null, serial: null,
    interfaces: [], vlans: [], neighbors: [], authFailure: false, raw: [],
  };

  let anySuccess = false;
  let lastErr = null;

  for (const { oid, label } of oidSets) {
    const commands = buildSnmpCommands(host, options, oid);
    if (!commands.length) continue;

    let oidSuccess = false;
    for (let attempt = 0; attempt <= retries && !oidSuccess; attempt++) {
      for (const command of commands) {
        const out = await runSnmpCmd(command, timeoutMs, options.execFn || execAsync);
        if (out.ok && out.stdout) {
          const parsed = parseSnmpOutput(out.stdout);
          // Merge interfaces (ifTable + ifXTable enriquecem)
          if (parsed.interfaces?.length) {
            const existingByIdx = new Map(merged.interfaces.map(i => [i.index, i]));
            for (const iface of parsed.interfaces) {
              const existing = existingByIdx.get(iface.index);
              if (existing) {
                // Merge: ifXTable enriquece ifTable (name vindo do ifX, speed do ifTable)
                Object.assign(existing, Object.fromEntries(
                  Object.entries(iface).filter(([,v]) => v != null)
                ));
              } else {
                merged.interfaces.push(iface);
              }
            }
          }
          // Merge top-level fields (system MIB)
          if (parsed.sysDescr) merged.sysDescr = parsed.sysDescr;
          if (parsed.sysName) merged.sysName = parsed.sysName;
          if (parsed.sysUptime) merged.sysUptime = parsed.sysUptime;
          if (parsed.sysContact) merged.sysContact = parsed.sysContact;
          if (parsed.sysLocation) merged.sysLocation = parsed.sysLocation;
          if (parsed.vendor) merged.vendor = parsed.vendor;
          if (parsed.model) merged.model = parsed.model;
          if (parsed.serial) merged.serial = parsed.serial;
          if (parsed.authFailure) merged.authFailure = true;
          if (parsed.vlans?.length) merged.vlans = [...new Set([...merged.vlans, ...parsed.vlans])];
          if (parsed.neighbors?.length) merged.neighbors = [...new Set([...merged.neighbors, ...parsed.neighbors])];
          merged.raw.push(...(parsed.raw || []));

          oidSuccess = true;
          anySuccess = true;
          break;
        }
        lastErr = out;

        if (lastErr && /auth|usm|authorization|unknown user name|wrongdigest/i.test(lastErr.stderr || '')) {
          merged.authFailure = true;
          oidSuccess = true; // não retentar em auth failure
          break;
        }
      }
    }
  }

  if (!anySuccess) return null;

  merged.snmp_meta = {
    command: lastErr?.command || 'snmpwalk',
    timeoutMs,
    version: String(options.version || process.env.DISCOVERY_SNMP_VERSION || '2c'),
    physical_layer: physicalLayerEnabled,
  };
  // Ordenar interfaces por índice
  merged.interfaces.sort((a, b) => (a.index || 0) - (b.index || 0));
  return merged;
}

module.exports = {
  parseSnmpOutput,
  buildSnmpCommands,
  runSnmpCmd,
  probeSnmpTarget,
};
