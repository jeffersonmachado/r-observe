'use strict';

const { v4: uuidv4 } = require('uuid');
const { signInternalToken } = require('@results/auth');
const { getTenantId } = require('../shared/tenant-context');

/**
 * Processador de eventos do worker: incidentes, remediações, análise proativa.
 * Extraído de index.js para reduzir o tamanho do arquivo principal.
 */

function createEventProcessor({ db, remediation, icinga, log, config }) {
  const {
    AI_ENABLED,
    AI_SERVICE_URL,
    REMEDIATION_ENABLED,
    PROACTIVE_STALE_MIN,
  } = config;

  // ─── Contadores de remediação ───────────────────────────────────────────────
  const rem = { auto: 0, pending: 0, approved: 0, rejected: 0, success: 0, failed: 0 };

  // ─── AI helper ──────────────────────────────────────────────────────────────
  async function callAI(incident, context) {
    if (!AI_ENABLED) return null;
    try {
      const jwt = signInternalToken({
        sub: 'r-observe-worker',
        service: 'worker',
        role: 'operator',
        aud: 'ai',
        scope: ['ai:access', 'ai:explain'],
        tenant_id: getTenantId(),
      });
      const resp = await fetch(`${AI_SERVICE_URL}/ai/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': jwt },
        body: JSON.stringify({ incident, context }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      log('warn', 'AI call failed', { err: e.message });
      return null;
    }
  }

  // ─── Contexto enriquecido para a IA ────────────────────────────────────────
  async function buildAIContext(hostId, event) {
    const ctx = {
      event_output:  event.output  || event.message || null,
      event_service: event.service || null,
      host_address:  event.address || null,
      recent_incidents:    [],
      recent_remediations: [],
    };
    try {
      const [incidents, remediations] = await Promise.all([
        db.query(
          `SELECT title, severity, status, created_at, resolved_at
           FROM observe_incidents
           WHERE host_id = $1
             AND created_at > NOW() - INTERVAL '7 days'
           ORDER BY created_at DESC
           LIMIT 5`,
          [hostId]
        ),
        db.query(
          `SELECT r.action, r.reason, r.status, r.requested_at
           FROM observe_remediations r
           JOIN observe_incidents i ON r.incident_id = i.id
           WHERE i.host_id = $1
             AND r.requested_at > NOW() - INTERVAL '7 days'
           ORDER BY r.requested_at DESC
           LIMIT 3`,
          [hostId]
        ),
      ]);
      ctx.recent_incidents    = incidents.rows;
      ctx.recent_remediations = remediations.rows;
    } catch (e) {
      log('warn', 'Failed to build AI context', { err: e.message });
    }
    return ctx;
  }

  // ─── Upsert host (DB + Icinga2) ─────────────────────────────────────────────
  async function upsertHost(name, address, metadata = {}) {
    const r = await db.query(
      `INSERT INTO observe_hosts (id, name, address, metadata, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET address = EXCLUDED.address, metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [uuidv4(), name, address, JSON.stringify(metadata)]
    );
    const { id, inserted } = r.rows[0];

    if (inserted && address) {
      icinga.registerHost(name, address, name, {}).then(res => {
        if (!res.ok) log('warn', 'Icinga2 host sync failed', { name, status: res.status });
        else         log('debug', 'Icinga2 host synced', { name, existed: res.existed });
      }).catch(e => log('warn', 'Icinga2 host sync error', { name, err: e.message }));
    }

    return id;
  }

  // ─── Remediação com supervisão por score ────────────────────────────────────
  async function scheduleOrExecuteRemediation(incidentId, severity, remediationInput) {
    const { action, params = {}, confidence_score = 0, reasoning = '' } = remediationInput;

    if (!remediation.isActionAllowed(action)) {
      log('warn', 'Remediation action not in catalog, skipping', { action });
      return;
    }

    const autoOk = remediation.canAutoExecute(action, confidence_score, severity);
    const remId  = uuidv4();
    const status = autoOk ? 'executing' : 'pending_approval';

    await db.query(
      `INSERT INTO observe_remediations
         (id, incident_id, action, params, reason, status, confidence_score, auto_executed, requested_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
      [remId, incidentId, action, JSON.stringify(params), reasoning || null,
       status, confidence_score, autoOk]
    );

    if (!autoOk) {
      rem.pending++;
      log('info', 'Remediation pending approval', {
        incident_id: incidentId, action,
        score: confidence_score,
        threshold: remediation.AUTO_THRESHOLD,
        max_severity: remediation.MAX_AUTO_SEVERITY,
        incident_severity: severity,
      });
      return;
    }

    rem.auto++;
    log('info', 'Auto-executing remediation', { incident_id: incidentId, action, score: confidence_score });
    const result = await remediation.executeAction(action, params);
    const finalStatus = result.success ? 'executed' : 'failed';
    result.success ? rem.success++ : rem.failed++;

    await db.query(
      `UPDATE observe_remediations
       SET status = $1, execution_output = $2, executed_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [finalStatus, result.output || null, remId]
    );
    await db.query(
      `INSERT INTO observe_incident_events
         (id, incident_id, event_type, source, payload, occurred_at)
       VALUES ($1,$2,'remediation_auto_executed','r-observe-worker',$3,NOW())`,
      [uuidv4(), incidentId, JSON.stringify({ action, params, result, confidence_score })]
    );

    log(result.success ? 'info' : 'warn', 'Remediation result',
      { incident_id: incidentId, action, ...result });
  }

  // ─── Processa resultado de scan de rede ─────────────────────────────────────
  async function processScanResults(raw) {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
    log('info', 'Processing scan results', { total: hosts.length });
    for (const h of hosts) {
      if (!h.name || !h.address) continue;
      try {
        await upsertHost(h.name, h.address, { source: 'network-scan', ports: h.ports || [], display_name: h.display_name });
      } catch (e) {
        log('warn', 'Failed to upsert scanned host', { name: h.name, err: e.message });
      }
    }
  }

  // ─── Process event ──────────────────────────────────────────────────────────
  async function processEvent(raw) {
    let event;
    try { event = JSON.parse(raw); }
    catch (e) { log('warn', 'Invalid JSON in event', { raw }); return; }

    log('debug', 'Processing event', { type: event.type, source: event.source });

    if (event.type === 'host.recovery' || event.type === 'service.recovery' || event.type === 'check.recovery') {
      const hostName = event.host || event.hostname || 'unknown';
      const hostId = await upsertHost(hostName, event.address || null, { source: event.source });
      const checkTitle = event.type === 'check.recovery'
        ? `[CHECK.FAILED] ${hostName} / ${event.target || 'unknown'}`
        : null;
      const closed = checkTitle
        ? await db.query(
          `UPDATE observe_incidents SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
           WHERE host_id = $1 AND status = 'open' AND title = $2 RETURNING id`,
          [hostId, checkTitle]
        )
        : await db.query(
          `UPDATE observe_incidents SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
           WHERE host_id = $1 AND status = 'open' RETURNING id`,
          [hostId]
        );
      if (closed.rowCount > 0) {
        log('info', 'Incidents resolved via recovery', { hostName, count: closed.rowCount });
      }
      return;
    }

    const incidentTriggers = [
      'host.down',
      'service.critical', 'service.warning',
      'container.stopped', 'container.unhealthy',
      'docker.daemon.down',
      'disk.high_usage', 'disk.full',
      'check.failed',
    ];
    if (!incidentTriggers.includes(event.type)) {
      log('debug', 'Event type does not trigger incident', { type: event.type });
      return;
    }

    const hostName = event.host || event.hostname || 'unknown';
    const hostId = await upsertHost(hostName, event.address || null, { source: event.source });
    const incidentSubject = event.service || event.target || event.filesystem || null;
    const title = `[${event.type.toUpperCase()}] ${hostName}${incidentSubject ? ' / ' + incidentSubject : ''}`;

    const existing = await db.query(
      `SELECT id FROM observe_incidents
       WHERE host_id = $1 AND status = 'open'
         AND (source_event_id = $2 OR title = $3)
       ORDER BY created_at DESC
       LIMIT 1`,
      [hostId, event.id || null, title]
    );
    if (existing.rowCount > 0) {
      const existingId = existing.rows[0].id;
      await db.query(
        `UPDATE observe_incidents
         SET updated_at = NOW(),
             metadata = metadata || jsonb_build_object(
               'last_event', $1::jsonb,
               'repeat_count', COALESCE((metadata->>'repeat_count')::integer, 0) + 1
             )
         WHERE id = $2`,
        [JSON.stringify(event), existingId]
      );
      log('debug', 'Incident recurrence coalesced', { incident_id: existingId, title });
      return { processed: false, duplicate: true, incident_id: existingId };
    }

    const incidentId = uuidv4();
    const severity = event.severity || (event.type === 'host.down' ? 'critical' : 'warning');

    await db.query(
      `INSERT INTO observe_incidents
         (id, title, severity, status, source, source_event_id, host_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, NOW(), NOW())`,
      [incidentId, title, severity, event.source || 'unknown', event.id || null, hostId, JSON.stringify(event)]
    );

    await db.query(
      `INSERT INTO observe_incident_events (id, incident_id, event_type, source, payload, occurred_at)
       VALUES ($1, $2, 'event_received', $3, $4, NOW())`,
      [uuidv4(), incidentId, event.source || 'unknown', JSON.stringify(event)]
    );

    log('info', 'Incident created', { incident_id: incidentId, title, severity });

    if (AI_ENABLED) {
      const aiContext = await buildAIContext(hostId, event);
      const aiResult  = await callAI({ id: incidentId, title, severity, source: event.source }, aiContext);
      if (aiResult) {
        await db.query(
          `UPDATE observe_incidents
           SET ai_summary = $1, ai_cause = $2, ai_suggestion = $3, ai_pattern = $4, updated_at = NOW()
           WHERE id = $5`,
          [aiResult.summary || null, aiResult.cause || null, aiResult.suggestion || null,
           aiResult.pattern || null, incidentId]
        );
        await db.query(
          `INSERT INTO observe_incident_events (id, incident_id, event_type, source, payload, occurred_at)
           VALUES ($1, $2, 'ai_analysis_complete', 'r-observe-ai', $3, NOW())`,
          [uuidv4(), incidentId, JSON.stringify(aiResult)]
        );
        log('info', 'AI analysis attached', { incident_id: incidentId });

        if (REMEDIATION_ENABLED && aiResult.remediation?.action) {
          await scheduleOrExecuteRemediation(incidentId, severity, aiResult.remediation);
        }
      }
    }

    return { processed: true };
  }

  // ─── Despacha remediações aprovadas via fila ────────────────────────────────
  async function dispatchApprovedRemediation(raw) {
    let task;
    try { task = JSON.parse(raw); } catch { return; }
    const { remediation_id, action, params, incident_id } = task;

    rem.approved++;
    log('info', 'Executing approved remediation', { remediation_id, action });
    const result = await remediation.executeAction(action, params || {});
    result.success ? rem.success++ : rem.failed++;
    const finalStatus = result.success ? 'executed' : 'failed';

    await db.query(
      `UPDATE observe_remediations
       SET status = $1, execution_output = $2, executed_at = NOW(),
           auto_executed = false, updated_at = NOW()
       WHERE id = $3`,
      [finalStatus, result.output || null, remediation_id]
    );
    if (incident_id) {
      await db.query(
        `INSERT INTO observe_incident_events
           (id, incident_id, event_type, source, payload, occurred_at)
         VALUES ($1,$2,'remediation_executed','r-observe-worker',$3,NOW())`,
        [uuidv4(), incident_id, JSON.stringify({ action, params, result, remediation_id })]
      );
    }
    log(result.success ? 'info' : 'warn', 'Approved remediation result',
      { remediation_id, action, ...result });
  }

  // ─── Monitoramento proativo — re-analisa incidentes abertos sem análise ─────
  async function proactiveAnalysis(processedCountRef) {
    if (!AI_ENABLED) return;
    try {
      const r = await db.query(
        `SELECT i.id, i.title, i.severity, i.source, i.host_id,
                h.address AS host_address, h.name AS host_name,
                i.metadata->>'event_output' AS event_output,
                i.metadata->>'event_service' AS event_service
         FROM observe_incidents i
         LEFT JOIN observe_hosts h ON i.host_id = h.id
         WHERE i.status = 'open'
           AND i.ai_summary IS NULL
           AND i.created_at < NOW() - INTERVAL '${PROACTIVE_STALE_MIN} minutes'
         ORDER BY i.created_at ASC
         LIMIT 5`
      );
      if (r.rowCount === 0) return;
      log('info', 'Proactive analysis', { stale_incidents: r.rowCount });

      for (const inc of r.rows) {
        const aiContext = await buildAIContext(inc.host_id, {
          output:  inc.event_output,
          service: inc.event_service,
          address: inc.host_address,
        });
        const aiResult = await callAI(
          { id: inc.id, title: inc.title, severity: inc.severity, source: inc.source },
          aiContext
        );
        if (!aiResult) continue;
        await db.query(
          `UPDATE observe_incidents
           SET ai_summary = $1, ai_cause = $2, ai_suggestion = $3, ai_pattern = $4, updated_at = NOW()
           WHERE id = $5`,
          [aiResult.summary || null, aiResult.cause || null, aiResult.suggestion || null,
           aiResult.pattern || null, inc.id]
        );
        log('info', 'Proactive AI analysis attached', { incident_id: inc.id });
        if (REMEDIATION_ENABLED && aiResult.remediation?.action) {
          await scheduleOrExecuteRemediation(inc.id, inc.severity, aiResult.remediation);
        }
        if (processedCountRef) processedCountRef.count++;
      }
    } catch (e) {
      log('warn', 'Proactive analysis error', { err: e.message });
    }
  }

  return {
    rem,
    processEvent,
    processScanResults,
    dispatchApprovedRemediation,
    proactiveAnalysis,
    upsertHost,
  };
}

module.exports = { createEventProcessor };
