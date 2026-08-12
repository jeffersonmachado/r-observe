'use strict';

// Kubernetes Discovery Scanner para R-Observe Discovery (Enterprise).
// Descobre pods, services, nodes, deployments e namespaces
// usando a API do Kubernetes (kubectl ou @kubernetes/client-node).
//
// Modos:
// 1. kubectl mode (default) - usa kubectl local com kubeconfig
// 2. In-cluster mode - usa service account token + CA do pod
// 3. API mode - conexao direta a API server via URL + token

const { execFile } = require('child_process');
const { promisify } = require('util');
const { log } = require('../utils/logger');

const execFileAsync = promisify(execFile);

const K8S_MODE = process.env.DISCOVERY_K8S_MODE || 'kubectl';   // kubectl | in-cluster | api
const K8S_API_URL = process.env.DISCOVERY_K8S_API_URL || '';     // https://k8s-api:6443
const K8S_TOKEN = process.env.DISCOVERY_K8S_TOKEN || '';         // Bearer token
const K8S_NAMESPACE = process.env.DISCOVERY_K8S_NAMESPACE || ''; // '' = all namespaces

function namespaceArgs() {
  return K8S_NAMESPACE ? ['-n', K8S_NAMESPACE] : ['--all-namespaces'];
}

async function kubectl(args, timeout) {
  return execFileAsync('kubectl', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
}

// Descobre via kubectl (modo default).
async function discoverViaKubectl() {
  const resources = {
    nodes: [],
    pods: [],
    services: [],
    deployments: [],
    namespaces: [],
  };

  try {
    // Namespaces
    const { stdout: nsOut } = await kubectl(['get', 'namespaces', '-o', 'json'], 10000);
    const nsData = JSON.parse(nsOut);
    for (const ns of (nsData.items || [])) {
      resources.namespaces.push({
        name: ns.metadata.name,
        status: ns.status.phase,
        uid: ns.metadata.uid,
        created_at: ns.metadata.creationTimestamp,
      });
    }

    // Nodes
    const { stdout: nodeOut } = await kubectl(['get', 'nodes', '-o', 'json'], 10000);
    const nodeData = JSON.parse(nodeOut);
    for (const node of (nodeData.items || [])) {
      const addresses = (node.status?.addresses || []).map(a => ({ type: a.type, address: a.address }));
      resources.nodes.push({
        name: node.metadata.name,
        internal_ip: addresses.find(a => a.type === 'InternalIP')?.address || null,
        external_ip: addresses.find(a => a.type === 'ExternalIP')?.address || null,
        os: node.status?.nodeInfo?.osImage || null,
        kubelet_version: node.status?.nodeInfo?.kubeletVersion || null,
        container_runtime: node.status?.nodeInfo?.containerRuntimeVersion || null,
        capacity: node.status?.capacity || {},
        conditions: (node.status?.conditions || []).map(c => ({ type: c.type, status: c.status })),
        uid: node.metadata.uid,
      });
    }

    // Pods
    const { stdout: podOut } = await kubectl(['get', 'pods', ...namespaceArgs(), '-o', 'json'], 15000);
    const podData = JSON.parse(podOut);
    for (const pod of (podData.items || [])) {
      const containers = (pod.spec?.containers || []).map(c => ({
        name: c.name,
        image: c.image,
        ports: (c.ports || []).map(p => ({ name: p.name, container_port: p.containerPort, protocol: p.protocol })),
      }));
      resources.pods.push({
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        node_name: pod.spec?.nodeName || null,
        pod_ip: pod.status?.podIP || null,
        host_ip: pod.status?.hostIP || null,
        phase: pod.status?.phase,
        containers,
        labels: pod.metadata.labels || {},
        uid: pod.metadata.uid,
        created_at: pod.metadata.creationTimestamp,
      });
    }

    // Services
    const { stdout: svcOut } = await kubectl(['get', 'services', ...namespaceArgs(), '-o', 'json'], 10000);
    const svcData = JSON.parse(svcOut);
    for (const svc of (svcData.items || [])) {
      resources.services.push({
        name: svc.metadata.name,
        namespace: svc.metadata.namespace,
        type: svc.spec.type,
        cluster_ip: svc.spec.clusterIP,
        external_ip: svc.status?.loadBalancer?.ingress?.[0]?.ip || svc.spec.externalIPs?.[0] || null,
        ports: (svc.spec.ports || []).map(p => ({
          name: p.name,
          port: p.port,
          target_port: p.targetPort,
          protocol: p.protocol,
          node_port: p.nodePort || null,
        })),
        selector: svc.spec.selector || {},
        uid: svc.metadata.uid,
      });
    }

    // Deployments
    const { stdout: deployOut } = await kubectl(['get', 'deployments', ...namespaceArgs(), '-o', 'json'], 10000);
    const deployData = JSON.parse(deployOut);
    for (const deploy of (deployData.items || [])) {
      resources.deployments.push({
        name: deploy.metadata.name,
        namespace: deploy.metadata.namespace,
        replicas: deploy.spec.replicas,
        ready_replicas: deploy.status?.readyReplicas || 0,
        image: deploy.spec?.template?.spec?.containers?.[0]?.image || null,
        uid: deploy.metadata.uid,
      });
    }

    log('info', 'Kubernetes discovery completed (kubectl)', {
      nodes: resources.nodes.length,
      pods: resources.pods.length,
      services: resources.services.length,
      deployments: resources.deployments.length,
      namespaces: resources.namespaces.length,
    });

  } catch (e) {
    log('warn', 'Kubernetes discovery via kubectl failed', { err: e.message });
  }

  return resources;
}

// Descobre via API REST (modo in-cluster ou remoto).
async function discoverViaApi() {
  if (!K8S_API_URL || !K8S_TOKEN) {
    log('warn', 'K8s API discovery requires K8S_API_URL and K8S_TOKEN');
    return { nodes: [], pods: [], services: [], deployments: [], namespaces: [] };
  }

  const headers = {
    'Authorization': `Bearer ${K8S_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const resources = { nodes: [], pods: [], services: [], deployments: [], namespaces: [] };

  try {
    const base = K8S_API_URL.replace(/\/$/, '');

    const apiGet = async (path) => {
      const resp = await fetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return { items: [] };
      return resp.json();
    };

    // Namespaces
    const ns = await apiGet('/api/v1/namespaces');
    for (const item of (ns.items || [])) {
      resources.namespaces.push({ name: item.metadata.name, status: item.status.phase, uid: item.metadata.uid });
    }

    // Nodes
    const nodes = await apiGet('/api/v1/nodes');
    for (const node of (nodes.items || [])) {
      const addrs = (node.status?.addresses || []).map(a => ({ type: a.type, address: a.address }));
      resources.nodes.push({
        name: node.metadata.name,
        internal_ip: addrs.find(a => a.type === 'InternalIP')?.address || null,
        os: node.status?.nodeInfo?.osImage || null,
      });
    }

    // Pods
    const pods = await apiGet('/api/v1/pods');
    for (const pod of (pods.items || [])) {
      resources.pods.push({
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        pod_ip: pod.status?.podIP || null,
        node_name: pod.spec?.nodeName || null,
        phase: pod.status?.phase,
      });
    }

    // Services
    const svcs = await apiGet('/api/v1/services');
    for (const svc of (svcs.items || [])) {
      resources.services.push({
        name: svc.metadata.name,
        namespace: svc.metadata.namespace,
        type: svc.spec.type,
        cluster_ip: svc.spec.clusterIP,
        ports: (svc.spec.ports || []).map(p => ({ port: p.port, protocol: p.protocol })),
      });
    }

    log('info', 'Kubernetes discovery completed (API)', {
      nodes: resources.nodes.length,
      pods: resources.pods.length,
      services: resources.services.length,
    });

  } catch (e) {
    log('warn', 'Kubernetes API discovery failed', { err: e.message });
  }

  return resources;
}

// Orquestrador.
async function discoverKubernetes() {
  if (K8S_MODE === 'api') return discoverViaApi();
  return discoverViaKubectl();
}

// Testa se kubectl esta disponivel.
async function isKubectlAvailable() {
  try {
    await kubectl(['version', '--client'], 5000);
    return true;
  } catch {
    return false;
  }
}

module.exports = { discoverKubernetes, discoverViaKubectl, discoverViaApi, isKubectlAvailable };
