import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantEnv, cleanIntegrations, INTEGRATION_FIELDS } from '../server/platform/tenant-env.js';
import { featureForMethod, ROUTE_FEATURES, PLANS } from '../server/platform/plans.js';

// Fake values only, clearly not real credentials.
const PLATFORM = { ADP_CLIENT_ID: 'platform-default-id', ADP_CLIENT_SECRET: 'platform-default-secret', ADP_CERT_PEM: 'x', ADP_KEY_PEM: 'y', JWT_SECRET: 'j' };

test('ADP on the platform: per-restaurant settings, never inherited, off when not in the plan', () => {
  const bistro = { id: 't1', slug: 'bistro', name: 'Bistro', is_default: false, integrations: { ADP_MANAGER_AOID: 'G3ABC123' }, resolved: { adp: true } };
  const env = tenantEnv(PLATFORM, bistro, { ADP_CLIENT_ID: 'bistro-id', ADP_CLIENT_SECRET: 'bistro-secret-value' });
  assert.equal(env.ADP_CLIENT_ID, 'bistro-id');
  assert.equal(env.ADP_MANAGER_AOID, 'G3ABC123');
  assert.equal(env.ADP_CERT_PEM, undefined, 'another restaurant never inherits the default restaurant’s ADP values');

  const starter = tenantEnv(PLATFORM, { ...bistro, resolved: { adp: false } }, { ADP_CLIENT_ID: 'bistro-id' });
  assert.ok(!Object.keys(starter).some((k) => k.startsWith('ADP_')), 'no ADP values when ADP isn’t in the plan');

  const def = tenantEnv(PLATFORM, { id: 'default', is_default: true, integrations: {}, resolved: { adp: true } });
  assert.equal(def.ADP_CLIENT_ID, 'platform-default-id', 'the first client keeps its env vars');

  assert.ok(INTEGRATION_FIELDS.some((f) => f.key === 'ADP_KEY_PEM' && f.secret && f.multiline));
  assert.throws(() => cleanIntegrations({ ADP_CERT_PEM: 'not a certificate' }), /whole certificate/);
  const ok = cleanIntegrations({ ADP_CERT_PEM: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' });
  assert.ok(ok.secrets.ADP_CERT_PEM.startsWith('-----BEGIN CERTIFICATE-----'));

  assert.equal(featureForMethod('adp.importCsv'), 'adp');
  assert.equal(featureForMethod('calibration.week'), 'forecast');
  assert.ok(ROUTE_FEATURES.some(([path, f]) => path === '/api/adp' && f === 'adp'));
  assert.ok(PLANS.pro.features.includes('adp') && !PLANS.starter.features.includes('adp'));
});
