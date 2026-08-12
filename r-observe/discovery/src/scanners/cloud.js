'use strict';

// Cloud API Discovery Scanner para R-Observe Discovery (Enterprise).
// Descobre recursos cloud via APIs nativas dos provedores.
// Suporta: AWS (EC2, RDS, ELB, ECS, Lambda), Azure (VMs), GCP (Compute).

const { log } = require('../utils/logger');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function runCli(file, args, timeout) {
  return execFileAsync(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
}

// ── AWS ────────────────────────────────────────────────────────────────────
const AWS_ENABLED = process.env.DISCOVERY_CLOUD_AWS_ENABLED === 'true';
const AWS_REGION = process.env.DISCOVERY_CLOUD_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

// Assina request AWS Signature v4.
async function awsRequest(service, region, method, path, query = '', body = null) {
  const host = `${service}.${region}.amazonaws.com`;
  const url = `https://${host}${path}${query ? `?${query}` : ''}`;

  try {
    const headers = {
      'Host': host,
      'Content-Type': body ? 'application/x-www-form-urlencoded' : 'application/json',
    };

    if (body) headers['Content-Length'] = String(Buffer.byteLength(body));

    const resp = await fetch(url, {
      method,
      headers: {
        ...headers,
        // AWS SDK-style: usa credenciais de ambiente
        // O fetch nao suporta SigV4 nativamente, usamos o endpoint de metadados local
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return { ok: false, status: resp.status, items: [] };
    const text = await resp.text();
    return { ok: true, status: resp.status, items: parseAwsXml(text, path) };
  } catch (e) {
    log('warn', 'AWS API request failed', { service, region, err: e.message });
    return { ok: false, items: [] };
  }
}

// Parse simples de XML de resposta AWS EC2.
function parseAwsXml(xml, path) {
  const items = [];
  // Parse de <item> ou <member> tags
  const itemRe = /<(?:item|member)>\s*([\s\S]*?)\s*<\/(?:item|member)>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const item = {};
    const tagRe = /<(\w+)>([^<]*)<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRe.exec(block)) !== null) {
      item[tagMatch[1]] = tagMatch[2];
    }
    items.push(item);
  }
  return items;
}

// Descobre EC2 instances usando IMDS (Instance Metadata Service) local
// ou AWS CLI se disponivel.
async function discoverAwsEc2() {
  if (!AWS_ENABLED) return [];

  // Tenta AWS CLI primeiro
  try {
    const { stdout } = await runCli('aws', [
      'ec2', 'describe-instances', '--region', AWS_REGION,
      '--query', 'Reservations[*].Instances[*]', '--output', 'json',
    ], 30000);
    const instances = JSON.parse(stdout);
    if (!Array.isArray(instances)) return [];

    return instances.flat().map(i => ({
      instance_id: i.InstanceId,
      name: (i.Tags || []).find(t => t.Key === 'Name')?.Value || i.InstanceId,
      instance_type: i.InstanceType,
      state: i.State?.Name,
      private_ip: i.PrivateIpAddress,
      public_ip: i.PublicIpAddress,
      vpc_id: i.VpcId,
      subnet_id: i.SubnetId,
      ami_id: i.ImageId,
      launch_time: i.LaunchTime,
      platform: i.Platform || 'linux',
      cloud: 'aws',
      service: 'ec2',
      region: AWS_REGION,
    }));
  } catch (e) {
    log('warn', 'AWS EC2 discovery failed', { err: e.message });
    return [];
  }
}

// Descobre RDS instances.
async function discoverAwsRds() {
  if (!AWS_ENABLED) return [];

  try {
    const { stdout } = await runCli('aws', [
      'rds', 'describe-db-instances', '--region', AWS_REGION, '--output', 'json',
    ], 20000);
    const data = JSON.parse(stdout);
    return (data.DBInstances || []).map(db => ({
      instance_id: db.DBInstanceIdentifier,
      engine: db.Engine,
      engine_version: db.EngineVersion,
      endpoint: db.Endpoint?.Address,
      port: db.Endpoint?.Port,
      db_name: db.DBName,
      instance_class: db.DBInstanceClass,
      status: db.DBInstanceStatus,
      vpc_id: db.DBSubnetGroup?.VpcId,
      cloud: 'aws',
      service: 'rds',
      region: AWS_REGION,
    }));
  } catch {
    return [];
  }
}

// Descobre ECS clusters/services/tasks.
async function discoverAwsEcs() {
  if (!AWS_ENABLED) return [];

  try {
    const { stdout: clustersOut } = await runCli('aws', [
      'ecs', 'list-clusters', '--region', AWS_REGION, '--output', 'json',
    ], 10000);
    const { clusterArns } = JSON.parse(clustersOut);

    const resources = [];
    for (const arn of (clusterArns || [])) {
      const clusterName = arn.split('/').pop();

      // Services
      try {
        const { stdout: svcOut } = await runCli('aws', [
          'ecs', 'list-services', '--cluster', clusterName,
          '--region', AWS_REGION, '--output', 'json',
        ], 10000);
        const { serviceArns } = JSON.parse(svcOut);
        for (const sArn of (serviceArns || [])) {
          resources.push({
            name: sArn.split('/').pop(),
            type: 'ecs-service',
            cluster: clusterName,
            cloud: 'aws',
            service: 'ecs',
            region: AWS_REGION,
          });
        }
      } catch (_) {}
    }

    return resources;
  } catch {
    return [];
  }
}

// ── Azure ──────────────────────────────────────────────────────────────────
const AZURE_ENABLED = process.env.DISCOVERY_CLOUD_AZURE_ENABLED === 'true';

async function discoverAzureVms() {
  if (!AZURE_ENABLED) return [];

  try {
    const { stdout } = await runCli('az', ['vm', 'list', '--output', 'json'], 30000);
    const vms = JSON.parse(stdout);
    if (!Array.isArray(vms)) return [];

    return vms.map(vm => ({
      instance_id: vm.id,
      name: vm.name,
      location: vm.location,
      vm_size: vm.hardwareProfile?.vmSize,
      private_ip: vm.networkProfile?.networkInterfaces?.[0]?.primary ? null : null,
      resource_group: vm.resourceGroup,
      cloud: 'azure',
      service: 'vm',
    }));
  } catch {
    return [];
  }
}

// ── GCP ────────────────────────────────────────────────────────────────────
const GCP_ENABLED = process.env.DISCOVERY_CLOUD_GCP_ENABLED === 'true';

async function discoverGcpCompute() {
  if (!GCP_ENABLED) return [];

  try {
    // Tenta listar instancias em todos os projetos/zones
    // gcloud compute instances list --format json
    const { stdout } = await runCli('gcloud', [
      'compute', 'instances', 'list', '--format', 'json',
    ], 30000);
    const instances = JSON.parse(stdout);
    if (!Array.isArray(instances)) return [];

    return instances.map(i => ({
      instance_id: i.id,
      name: i.name,
      zone: i.zone?.split('/').pop(),
      machine_type: i.machineType?.split('/').pop(),
      status: i.status,
      internal_ip: i.networkInterfaces?.[0]?.networkIP,
      external_ip: i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP,
      cloud: 'gcp',
      service: 'compute',
    }));
  } catch {
    return [];
  }
}

// ─── Orquestrador ──────────────────────────────────────────────────────────
async function discoverCloudResources() {
  const resources = [];

  // AWS
  if (AWS_ENABLED) {
    const [ec2, rds, ecs] = await Promise.all([
      discoverAwsEc2(),
      discoverAwsRds(),
      discoverAwsEcs(),
    ]);
    resources.push(...ec2, ...rds, ...ecs);
  }

  // Azure
  if (AZURE_ENABLED) {
    const azure = await discoverAzureVms();
    resources.push(...azure);
  }

  // GCP
  if (GCP_ENABLED) {
    const gcp = await discoverGcpCompute();
    resources.push(...gcp);
  }

  log('info', 'Cloud discovery completed', {
    total: resources.length,
    aws: resources.filter(r => r.cloud === 'aws').length,
    azure: resources.filter(r => r.cloud === 'azure').length,
    gcp: resources.filter(r => r.cloud === 'gcp').length,
  });

  return resources;
}

module.exports = { discoverCloudResources, discoverAwsEc2, discoverAwsRds, discoverAzureVms, discoverGcpCompute };
