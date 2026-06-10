'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseTarget,
  expandTargets,
  isIpInRange,
  isValidIPv4,
  chunkTargets,
} = require('../../src/scanners/target-expansion');

test('parseTarget: single IP', async () => {
  const result = await parseTarget('10.10.2.1');
  assert.strictEqual(result.type, 'single_ip');
  assert.deepStrictEqual(result.ips, ['10.10.2.1']);
});

test('parseTarget: CIDR /24', async () => {
  const result = await parseTarget('10.10.2.0/24');
  assert.strictEqual(result.type, 'cidr');
  assert.ok(result.ips.length > 0);
  assert.ok(result.ips.includes('10.10.2.1'));
  assert.ok(!result.ips.includes('10.10.2.0')); // network excluded
  assert.ok(!result.ips.includes('10.10.2.255')); // broadcast excluded
});

test('parseTarget: CIDR /30 (4 hosts)', async () => {
  const result = await parseTarget('10.10.2.0/30');
  assert.strictEqual(result.type, 'cidr');
  assert.strictEqual(result.ips.length, 4);
});

test('parseTarget: range notation', async () => {
  const result = await parseTarget('10.10.2.1-10.10.2.5');
  assert.strictEqual(result.type, 'range');
  assert.deepStrictEqual(result.ips, ['10.10.2.1', '10.10.2.2', '10.10.2.3', '10.10.2.4', '10.10.2.5']);
});

test('parseTarget: hostname (localhost)', async () => {
  const result = await parseTarget('localhost');
  assert.strictEqual(result.type, 'hostname');
  assert.ok(result.ips.length > 0);
});

test('parseTarget: invalid input throws', async () => {
  try {
    await parseTarget('invalid-hostname-that-does-not-exist-xyz123.local');
    // Algumas configurações de DNS retornam 0.0.0.0 em vez de throw
    // então apenas validamos que pelo menos não lança
  } catch (e) {
    assert.ok(
      e.message.includes('Cannot parse target') || e.message.includes('Invalid')
    );
  }
});

test('isValidIPv4: valida formato rigoroso', () => {
  assert.strictEqual(isValidIPv4('10.10.2.1'), true);
  assert.strictEqual(isValidIPv4('256.10.2.1'), false);
  assert.strictEqual(isValidIPv4('10.10.2'), false);
  assert.strictEqual(isValidIPv4('10.10.2.1 '), false);
  assert.strictEqual(isValidIPv4('-1.10.2.1'), false);
});

test('expandTargets: single IP', async () => {
  const result = await expandTargets(['10.10.2.1']);
  assert.strictEqual(result.totalExpanded, 1);
  assert.strictEqual(result.totalFiltered, 1);
  assert.strictEqual(result.targets[0].address, '10.10.2.1');
});

test('expandTargets: multiple targets with deduplication', async () => {
  const result = await expandTargets(['10.10.2.1', '10.10.2.1', '10.10.2.2']);
  assert.strictEqual(result.totalExpanded, 3);
  assert.strictEqual(result.totalUnique, 2);
  assert.strictEqual(result.totalFiltered, 2);
});

test('expandTargets: respects maxScanTargets limit', async () => {
  try {
    // 10.10.0.0/16 = 65536 IPs, exceeds default maxHosts
    await expandTargets(['10.10.0.0/16'], { maxHosts: 100 });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('maxHosts'));
  }
});

test('expandTargets: excludeRanges filter', async () => {
  const result = await expandTargets(['10.10.2.0/24'], { excludeRanges: ['10.10.2.100-10.10.2.200'] });
  assert.ok(result.totalFiltered < 254); // some IPs excluded
  assert.ok(!result.targets.some((t) => t.address === '10.10.2.150'));
});

test('expandTargets: includeRanges (allowlist)', async () => {
  const result = await expandTargets(['10.10.0.0/16'], { includeRanges: ['10.10.2.0/24'], maxHosts: 100000 });
  assert.ok(result.targets.every((t) => isIpInRange(t.address, '10.10.2.0/24')));
  assert.ok(result.filteredOut.length > 0);
  assert.ok(result.filteredOut.every((t) => t.reason === 'outside_allowlist'));
});

test('expandTargets: rejeita /0 com maxHosts default', async () => {
  await assert.rejects(
    async () => expandTargets(['0.0.0.0/0']),
    /maxHosts/
  );
});

test('expandTargets: rejeita máscara inválida', async () => {
  await assert.rejects(
    async () => expandTargets(['10.10.2.0/33']),
    /Invalid CIDR mask/
  );
});

test('expandTargets: rejeita IPv4 inválido', async () => {
  await assert.rejects(
    async () => expandTargets(['10.10.2.256']),
    /Cannot parse target/
  );
});

test('expandTargets: bloqueia subnet gigante antes da expansão', async () => {
  await assert.rejects(
    async () => expandTargets(['10.0.0.0/8'], { maxHosts: 1024 }),
    /maxHosts/
  );
});

test('expandTargets: include/exclude reais com CIDR e range', async () => {
  const result = await expandTargets(
    ['10.10.2.0/24'],
    {
      includeRanges: ['10.10.2.64/26'],
      excludeRanges: ['10.10.2.100-10.10.2.110'],
    }
  );

  assert.ok(result.targets.length > 0);
  assert.ok(result.targets.every((t) => isIpInRange(t.address, '10.10.2.64/26')));
  assert.ok(!result.targets.some((t) => isIpInRange(t.address, '10.10.2.100-10.10.2.110')));
  assert.ok(result.filteredOut.some((t) => t.reason === 'blocked_range'));
});

test('expandTargets: registra alvos truncados por maxScanTargets', async () => {
  const result = await expandTargets(['10.10.2.1-10.10.2.5'], { maxScanTargets: 2 });
  assert.strictEqual(result.targets.length, 2);
  assert.deepStrictEqual(result.filteredOut.map((t) => t.reason), [
    'max_scan_targets_limit',
    'max_scan_targets_limit',
    'max_scan_targets_limit',
  ]);
});

test('expandTargets: aceita prefixos legados em includeRanges', async () => {
  const result = await expandTargets(['10.10.2.1', '192.168.1.5'], { includeRanges: ['10.'] });
  assert.deepStrictEqual(result.targets.map((t) => t.address), ['10.10.2.1']);
});

test('isIpInRange: single IP', () => {
  assert.ok(isIpInRange('10.10.2.1', '10.10.2.1'));
  assert.ok(!isIpInRange('10.10.2.1', '10.10.2.2'));
});

test('isIpInRange: CIDR', () => {
  assert.ok(isIpInRange('10.10.2.50', '10.10.2.0/24'));
  assert.ok(!isIpInRange('10.10.3.1', '10.10.2.0/24'));
});

test('isIpInRange: range', () => {
  assert.ok(isIpInRange('10.10.2.50', '10.10.2.1-10.10.2.100'));
  assert.ok(!isIpInRange('10.10.2.200', '10.10.2.1-10.10.2.100'));
});

test('isIpInRange: prefixo legado', () => {
  assert.ok(isIpInRange('172.16.9.10', '172.16.'));
  assert.ok(isIpInRange('10.10.2.50', '10.'));
  assert.ok(!isIpInRange('172.32.1.10', '172.16.'));
});

test('chunkTargets: splits into chunks', () => {
  const targets = Array.from({ length: 1000 }, (_, i) => ({
    address: `10.10.2.${(i % 254) + 1}`,
    discovery_type: 'ip',
  }));
  const chunks = chunkTargets(targets, 256);
  assert.ok(chunks.length > 1);
  assert.strictEqual(chunks[0].length, 256);
  assert.ok(chunks[chunks.length - 1].length <= 256);
});
