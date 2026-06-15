'use strict';

/**
 * SNMP Metrics Collector — coleta contadores SNMP periodicamente
 * e produz métricas no formato Prometheus (text exposition).
 *
 * Este módulo preenche o gap de "não preciso de exporter no alvo":
 * os contadores SNMP (tráfego de interfaces, CPU, memória, storage)
 * são coletados diretamente via SNMP e expostos para o Prometheus.
 *
 * Uso:
 *   - Modo pull: endpoint HTTP /metrics/snmp?target=10.10.2.1
 *   - Modo push: coletor periódico que faz push para Prometheus Pushgateway
 *   - Modo file: escreve métricas em arquivo para node_exporter textfile collector
 */

const { snmpGet, snmpWalkParsed, snmpWalkIndexed, cleanSnmpValue } = require('../mibs/snmp-walk');
const { OIDS } = require('../mibs/snmp-oids');
const { log } = require('../utils/logger');

// ── Helpers ─────────────────────────────────────────────────────────────────

function intVal(v) { const n = parseInt(v); return isNaN(n) ? null : n; }
function floatVal(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function escapeMetric(s) { return String(s || '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, ''); }

/**
 * Coleta métricas de um host via SNMP e retorna no formato Prometheus text.
 *
 * Métricas coletadas:
 *   - snmp_up
 *   - snmp_collect_duration_seconds
 *   - ifHCInOctets / ifHCOutOctets (64-bit)
 *   - ifInErrors / ifOutErrors
 *   - ifOperStatus
 *   - cpu_usage_percent (user/system/idle)
 *   - memory_total_bytes / memory_used_bytes
 *   - storage_total_bytes / storage_used_bytes
 */
async function collectMetrics(host, opts = {}) {
  const community = opts.community || 'public';
  const labels = opts.labels || {};
  const labelStr = Object.entries({ ...labels, snmp_target: host })
    .map(([k, v]) => `${escapeMetric(k)}="${String(v).replace(/"/g, '\\"')}"`)
    .join(',');

  const lines = [];
  const prefix = opts.prefix || 'r_observe_snmp';

  const start = Date.now();
  let up = 0;

  try {
    // Probe rápido
    const sysDescr = await snmpGet(host, OIDS.system.sysDescr, {
      community, timeout: 5000,
    });

    if (!sysDescr) {
      lines.push(`# HELP ${prefix}_up SNMP reachable (1=yes, 0=no)`);
      lines.push(`# TYPE ${prefix}_up gauge`);
      lines.push(`${prefix}_up{${labelStr}} 0`);
      lines.push(`# HELP ${prefix}_collect_duration_seconds Time to collect SNMP metrics`);
      lines.push(`# TYPE ${prefix}_collect_duration_seconds gauge`);
      lines.push(`${prefix}_collect_duration_seconds{${labelStr}} ${((Date.now() - start) / 1000).toFixed(3)}`);
      return lines.join('\n');
    }

    up = 1;

    // ── Interface counters (64-bit) ──────────────────────────────────────
    const [hcIn, hcOut, ifName, ifOper, ifInErr, ifOutErr, ifSpeed, ifHighSpeed] = await Promise.all([
      snmpWalkIndexed(host, OIDS.ifXTable.ifHCInOctets, { community }),
      snmpWalkIndexed(host, OIDS.ifXTable.ifHCOutOctets, { community }),
      snmpWalkIndexed(host, OIDS.ifXTable.ifName, { community }),
      snmpWalkIndexed(host, OIDS.interfaces.ifOperStatus, { community }),
      snmpWalkIndexed(host, OIDS.interfaces.ifInErrors, { community }),
      snmpWalkIndexed(host, OIDS.interfaces.ifOutErrors, { community }),
      snmpWalkIndexed(host, OIDS.interfaces.ifSpeed, { community }),
      snmpWalkIndexed(host, OIDS.ifXTable.ifHighSpeed, { community }),
    ]);

    const allIndexes = new Set([
      ...Object.keys(hcIn), ...Object.keys(hcOut), ...Object.keys(ifName),
      ...Object.keys(ifOper), ...Object.keys(ifInErr), ...Object.keys(ifOutErr),
      ...Object.keys(ifSpeed), ...Object.keys(ifHighSpeed),
    ]);

    lines.push(`# HELP ${prefix}_if_hc_in_octets Interface 64-bit input octets`);
    lines.push(`# TYPE ${prefix}_if_hc_in_octets counter`);
    lines.push(`# HELP ${prefix}_if_hc_out_octets Interface 64-bit output octets`);
    lines.push(`# TYPE ${prefix}_if_hc_out_octets counter`);
    lines.push(`# HELP ${prefix}_if_in_errors Interface input errors`);
    lines.push(`# TYPE ${prefix}_if_in_errors counter`);
    lines.push(`# HELP ${prefix}_if_out_errors Interface output errors`);
    lines.push(`# TYPE ${prefix}_if_out_errors counter`);
    lines.push(`# HELP ${prefix}_if_oper_status Interface operational status (1=up, 2=down)`);
    lines.push(`# TYPE ${prefix}_if_oper_status gauge`);
    lines.push(`# HELP ${prefix}_if_speed_bps Interface speed in bits/sec`);
    lines.push(`# TYPE ${prefix}_if_speed_bps gauge`);

    for (const idx of allIndexes) {
      const ifLabel = `${labelStr},if_index="${idx}",if_name="${escapeMetric(ifName[idx] || `if${idx}`)}"`;
      if (hcIn[idx] !== undefined)   lines.push(`${prefix}_if_hc_in_octets{${ifLabel}} ${hcIn[idx]}`);
      if (hcOut[idx] !== undefined)  lines.push(`${prefix}_if_hc_out_octets{${ifLabel}} ${hcOut[idx]}`);
      if (ifInErr[idx] !== undefined) lines.push(`${prefix}_if_in_errors{${ifLabel}} ${ifInErr[idx]}`);
      if (ifOutErr[idx] !== undefined) lines.push(`${prefix}_if_out_errors{${ifLabel}} ${ifOutErr[idx]}`);
      if (ifOper[idx] !== undefined)  lines.push(`${prefix}_if_oper_status{${ifLabel}} ${ifOper[idx]}`);
      if (ifSpeed[idx] !== undefined) lines.push(`${prefix}_if_speed_bps{${ifLabel}} ${ifSpeed[idx]}`);
    }

    // ── CPU ──────────────────────────────────────────────────────────────
    const [cpuUser, cpuSystem, cpuIdle, cpuWait] = await snmpGet(host, [
      OIDS.ucd.ssCpuRawUser, OIDS.ucd.ssCpuRawSystem, OIDS.ucd.ssCpuRawIdle, OIDS.ucd.ssCpuRawWait,
    ], { community });

    if (cpuUser !== null) {
      const user = intVal(cpuUser) || 0;
      const sys = intVal(cpuSystem) || 0;
      const idle = intVal(cpuIdle) || 0;
      const wait = intVal(cpuWait) || 0;
      const total = user + sys + idle + wait;

      lines.push(`# HELP ${prefix}_cpu_usage_percent CPU usage percentage`);
      lines.push(`# TYPE ${prefix}_cpu_usage_percent gauge`);
      if (total > 0) {
        lines.push(`${prefix}_cpu_usage_percent{${labelStr},mode="user"} ${((user / total) * 100).toFixed(1)}`);
        lines.push(`${prefix}_cpu_usage_percent{${labelStr},mode="system"} ${((sys / total) * 100).toFixed(1)}`);
        lines.push(`${prefix}_cpu_usage_percent{${labelStr},mode="idle"} ${((idle / total) * 100).toFixed(1)}`);
        if (wait > 0) lines.push(`${prefix}_cpu_usage_percent{${labelStr},mode="iowait"} ${((wait / total) * 100).toFixed(1)}`);
      }
    }

    // ── Memory ───────────────────────────────────────────────────────────
    const [memTotal, memAvail, memSwapTotal, memSwapAvail] = await snmpGet(host, [
      OIDS.ucd.memTotalReal, OIDS.ucd.memAvailReal, OIDS.ucd.memTotalSwap, OIDS.ucd.memAvailSwap,
    ], { community });

    if (memTotal !== null) {
      const total = intVal(memTotal) || 0;
      const avail = intVal(memAvail) || 0;
      lines.push(`# HELP ${prefix}_memory_total_kb Total memory in KB`);
      lines.push(`# TYPE ${prefix}_memory_total_kb gauge`);
      lines.push(`${prefix}_memory_total_kb{${labelStr}} ${total}`);
      lines.push(`# HELP ${prefix}_memory_avail_kb Available memory in KB`);
      lines.push(`# TYPE ${prefix}_memory_avail_kb gauge`);
      lines.push(`${prefix}_memory_avail_kb{${labelStr}} ${avail}`);
      lines.push(`# HELP ${prefix}_memory_used_pct Memory usage percentage`);
      lines.push(`# TYPE ${prefix}_memory_used_pct gauge`);
      if (total > 0) lines.push(`${prefix}_memory_used_pct{${labelStr}} ${(((total - avail) / total) * 100).toFixed(1)}`);
    }

    // ── Storage ─────────────────────────────────────────────────────────
    const storDescr = await snmpWalkIndexed(host, OIDS.host.hrStorageDescr, { community });
    const storSize = await snmpWalkIndexed(host, OIDS.host.hrStorageSize, { community });
    const storUsed = await snmpWalkIndexed(host, OIDS.host.hrStorageUsed, { community });
    const storUnits = await snmpWalkIndexed(host, OIDS.host.hrStorageAllocationUnits, { community });

    lines.push(`# HELP ${prefix}_storage_total_bytes Storage total bytes`);
    lines.push(`# TYPE ${prefix}_storage_total_bytes gauge`);
    lines.push(`# HELP ${prefix}_storage_used_bytes Storage used bytes`);
    lines.push(`# TYPE ${prefix}_storage_used_bytes gauge`);

    for (const idx of Object.keys(storSize)) {
      const mount = escapeMetric(storDescr[idx] || `storage${idx}`);
      const units = intVal(storUnits[idx]) || 1;
      const total = (intVal(storSize[idx]) || 0) * units;
      const used = (intVal(storUsed[idx]) || 0) * units;
      if (total > 0) {
        const sl = `${labelStr},mountpoint="${mount}"`;
        lines.push(`${prefix}_storage_total_bytes{${sl}} ${total}`);
        lines.push(`${prefix}_storage_used_bytes{${sl}} ${used}`);
      }
    }

  } catch (e) {
    log('warn', `SNMP metrics collection failed for ${host}`, { err: e.message });
    up = 0;
  }

  // UP gauge
  lines.unshift(`# HELP ${prefix}_up SNMP reachable (1=yes, 0=no)`);
  lines.unshift(`# TYPE ${prefix}_up gauge`);
  lines.splice(2, 0, `${prefix}_up{${labelStr}} ${up}`);

  // Duration
  lines.push(`# HELP ${prefix}_collect_duration_seconds Time to collect SNMP metrics`);
  lines.push(`# TYPE ${prefix}_collect_duration_seconds gauge`);
  lines.push(`${prefix}_collect_duration_seconds{${labelStr}} ${((Date.now() - start) / 1000).toFixed(3)}`);

  return lines.join('\n') + '\n';
}

/**
 * Coleta métricas e escreve no diretório textfile do node_exporter.
 */
async function writeTextfile(host, dir, opts = {}) {
  const metrics = await collectMetrics(host, opts);
  const fs = require('fs');
  const path = require('path');
  const filename = path.join(dir, `snmp_${host.replace(/[^a-zA-Z0-9_.-]/g, '_')}.prom`);
  const tmpfile = filename + '.tmp';

  try {
    fs.writeFileSync(tmpfile, metrics);
    fs.renameSync(tmpfile, filename);
  } catch (e) {
    log('error', `Failed to write SNMP textfile for ${host}`, { err: e.message });
  }
}

module.exports = { collectMetrics, writeTextfile };
