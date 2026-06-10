'use strict';

const net = require('net');
const dns = require('dns').promises;
const tls = require('tls');
const crypto = require('crypto');

async function reverseDns(ip) {
  try {
    const names = await dns.reverse(ip);
    return names[0] || null;
  } catch {
    return null;
  }
}

function tcpConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function httpFingerprint(target, tls = false) {
  const proto = tls ? 'https' : 'http';
  try {
    const resp = await fetch(`${proto}://${target}/`, { signal: AbortSignal.timeout(2500) });
    const headers = {};
    for (const [k, v] of resp.headers.entries()) headers[k.toLowerCase()] = v;
    const body = await resp.text().catch(() => '');
    const titleMatch = body.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    return { status: resp.status, headers, title: titleMatch ? titleMatch[1].trim() : null };
  } catch {
    return null;
  }
}

function readTcpBanner(host, port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    let data = '';
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value || null);
    };

    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
    sock.once('connect', () => {
      if (port === 25 || port === 587 || port === 465) {
        sock.write('EHLO r-observe.local\r\n');
      }
    });

    sock.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 512 || /\r\n/.test(data)) {
        finish(data.slice(0, 512).replace(/[\r\n]+/g, ' ').trim());
      }
    });

    sock.connect(port, host);
  });
}

function tlsCertificateFingerprint(host, port = 443, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: host });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.on('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.raw) return resolve(null);
      const sha256 = crypto.createHash('sha256').update(cert.raw).digest('hex');
      resolve({
        subject: cert.subject?.CN || null,
        issuer: cert.issuer?.CN || null,
        sha256,
        valid_from: cert.valid_from || null,
        valid_to: cert.valid_to || null,
      });
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function faviconHash(host, port = 80, tlsEnabled = false) {
  const proto = tlsEnabled ? 'https' : 'http';
  try {
    const resp = await fetch(`${proto}://${host}:${port}/favicon.ico`, { signal: AbortSignal.timeout(2500) });
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

module.exports = { reverseDns, tcpConnect, httpFingerprint, tlsCertificateFingerprint, faviconHash, readTcpBanner };
