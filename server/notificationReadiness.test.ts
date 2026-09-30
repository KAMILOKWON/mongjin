import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectNotificationReadiness } from './notificationReadiness';

const PROJECT_ID = 'cfdd161e-5912-437e-a1aa-e096fa64766b';
let fixtureDir: string;
let appConfigPath: string;
let certificatePath: string;
let privateKeyPath: string;
let mismatchedKeyPath: string;
let invalidCertificatePath: string;
let invalidKeyPath: string;
let apnsKeyPath: string;
let googleServicesPath: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'mongjin-notification-readiness-'));
  appConfigPath = join(fixtureDir, 'app.json');
  certificatePath = join(fixtureDir, 'toss-client-cert.pem');
  privateKeyPath = join(fixtureDir, 'toss-client-key.pem');
  mismatchedKeyPath = join(fixtureDir, 'other-key.pem');
  invalidCertificatePath = join(fixtureDir, 'invalid-cert.pem');
  invalidKeyPath = join(fixtureDir, 'invalid-key.pem');
  apnsKeyPath = join(fixtureDir, 'live-activity-key.p8');
  googleServicesPath = join(fixtureDir, 'google-services.json');

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', privateKeyPath, '-out', certificatePath, '-days', '2',
    '-subj', '/CN=notification-readiness.fixture',
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048',
    '-out', mismatchedKeyPath,
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-out', apnsKeyPath,
  ], { stdio: 'ignore' });

  await writeFile(invalidCertificatePath, 'not a certificate');
  await writeFile(invalidKeyPath, 'not a private key');
  await writeFile(googleServicesPath, JSON.stringify({
    project_info: { project_number: '1234567890', project_id: 'readiness-fixture' },
    client: [{ client_info: { mobilesdk_app_id: 'fixture' } }],
  }));
  await writeFile(appConfigPath, JSON.stringify({
    expo: {
      extra: { eas: { projectId: PROJECT_ID } },
      android: { googleServicesFile: 'google-services.json' },
    },
  }));
});

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

function completeEnvironment(): Record<string, string> {
  return {
    MONGJIN_PUSH_ENABLED: '1',
    MONGJIN_MATCH_PUSH_ENABLED: '1',
    TOSS_MTLS_CERT_PATH: certificatePath,
    TOSS_MTLS_KEY_PATH: privateKeyPath,
    MONGJIN_TOSS_TEMPLATE_CONFIRMED: 'template-fixture-confirmed',
    MONGJIN_TOSS_TEMPLATE_CANCELLED: 'template-fixture-cancelled',
    MONGJIN_TOSS_TEMPLATE_REMINDER: 'template-fixture-reminder',
    MONGJIN_TOSS_TEMPLATE_STARTED: 'template-fixture-started',
    MONGJIN_TOSS_TEMPLATE_FINISHED: 'template-fixture-finished',
    MONGJIN_TOSS_TEMPLATE_CHAMPION: 'template-fixture-champion',
    MONGJIN_APNS_KEY_PATH: apnsKeyPath,
    MONGJIN_APNS_KEY_ID: 'AB12CD34EF',
    MONGJIN_APNS_TEAM_ID: '1234567890',
    MONGJIN_APNS_BUNDLE_ID: 'com.studiozzg.mongjin',
    MONGJIN_APNS_ENVIRONMENT: 'sandbox',
  };
}

describe('notification readiness', () => {
  it('reports local configuration as configured-unverified without claiming provider credentials or approval', async () => {
    const report = await inspectNotificationReadiness(completeEnvironment(), { appConfigPath });

    expect(report.networkChecksPerformed).toBe(false);
    expect(report.flags).toEqual({ tournamentPushEnabled: true, matchPushEnabled: true });
    expect(report.overall).toEqual({
      status: 'configured-unverified',
      requiredConfigurationComplete: true,
      unconfigured: [],
    });
    expect(report.providers.toss).toMatchObject({
      status: 'configured-unverified',
      inferredReadiness: 'inferred-ready',
      externalVerification: 'not-performed',
      templateApprovalVerification: 'unavailable',
      mtls: { status: 'valid', pairMatches: true },
    });
    expect(Object.values(report.providers.toss.templates).every(template => template.configured)).toBe(true);
    expect(report.providers.expo).toMatchObject({
      status: 'configured-unverified',
      projectId: { status: 'valid', source: 'app-config' },
      androidGoogleServicesFileStatus: 'configured',
      credentialVerification: 'external-unavailable',
      providerKeys: {
        fcmV1: { configuration: 'not-inspected', readiness: 'unverified', externalVerification: 'unavailable' },
        apns: { configuration: 'not-inspected', readiness: 'unverified', externalVerification: 'unavailable' },
      },
    });
    expect(report.providers.liveActivityApns).toMatchObject({
      optional: true,
      configurationSupplied: true,
      localReadiness: 'inferred-ready',
      externalVerification: 'unavailable',
      keyFileStatus: 'valid',
    });

    const output = JSON.stringify(report);
    for (const secret of [
      PROJECT_ID,
      'template-fixture-reminder',
      'AB12CD34EF',
      certificatePath,
      privateKeyPath,
    ]) expect(output).not.toContain(secret);
  });

  it('does not block when both notification flags are off and makes no provider readiness claim', async () => {
    const report = await inspectNotificationReadiness({}, { appConfigPath: join(fixtureDir, 'missing-app.json') });

    expect(report.flags).toEqual({ tournamentPushEnabled: false, matchPushEnabled: false });
    expect(report.overall).toEqual({
      status: 'disabled',
      requiredConfigurationComplete: true,
      unconfigured: [],
    });
    expect(report.providers.expo.providerKeys.fcmV1.readiness).toBe('unverified');
    expect(report.providers.expo.providerKeys.apns.readiness).toBe('unverified');
  });

  it('uses app config first, falls back to an environment project id, and validates the effective UUID', async () => {
    const appConfigWithoutId = join(fixtureDir, 'app-without-project-id.json');
    await writeFile(appConfigWithoutId, JSON.stringify({
      expo: { android: { googleServicesFile: 'google-services.json' } },
    }));
    const good = await inspectNotificationReadiness({
      ...completeEnvironment(),
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
    }, { appConfigPath: appConfigWithoutId });
    expect(good.providers.expo.projectId).toEqual({ status: 'valid', source: 'environment' });

    const bad = await inspectNotificationReadiness({
      ...completeEnvironment(),
      EXPO_PUBLIC_EAS_PROJECT_ID: 'not-a-project-id',
    }, { appConfigPath: appConfigWithoutId });
    expect(bad.providers.expo.projectId).toEqual({ status: 'invalid', source: 'environment' });
    expect(bad.overall.unconfigured).toContain('expo-project-id');

    const configTakesPrecedence = await inspectNotificationReadiness({
      ...completeEnvironment(),
      EXPO_PUBLIC_EAS_PROJECT_ID: 'not-a-project-id',
    }, { appConfigPath });
    expect(configTakesPrecedence.providers.expo.projectId).toEqual({ status: 'valid', source: 'app-config' });
  });

  it('requires the Android Google services config when Expo notifications are enabled', async () => {
    const pathWithoutFirebase = join(fixtureDir, 'app-without-google-services.json');
    await writeFile(pathWithoutFirebase, JSON.stringify({
      expo: { extra: { eas: { projectId: PROJECT_ID } }, android: {} },
    }));
    const report = await inspectNotificationReadiness(completeEnvironment(), { appConfigPath: pathWithoutFirebase });

    expect(report.providers.expo.projectId.status).toBe('valid');
    expect(report.providers.expo.androidGoogleServicesFileStatus).toBe('not-configured');
    expect(report.overall.unconfigured).toContain('expo-android-google-services');
  });

  it('allows ordinary Expo match alerts without optional direct Live Activity APNs configuration', async () => {
    const report = await inspectNotificationReadiness({
      MONGJIN_MATCH_PUSH_ENABLED: '1',
    }, { appConfigPath });

    expect(report.flags.matchPushEnabled).toBe(true);
    expect(report.providers.expo).toMatchObject({
      requested: true,
      status: 'configured-unverified',
      projectId: { status: 'valid', source: 'app-config' },
      androidGoogleServicesFileStatus: 'configured',
      providerKeys: {
        fcmV1: { readiness: 'unverified', externalVerification: 'unavailable' },
        apns: { readiness: 'unverified', externalVerification: 'unavailable' },
      },
    });
    expect(report.providers.liveActivityApns).toMatchObject({
      optional: true,
      configurationSupplied: false,
      localReadiness: 'not-configured',
    });
    expect(report.overall).toEqual({
      status: 'configured-unverified',
      requiredConfigurationComplete: true,
      unconfigured: [],
    });
  });

  it('reports invalid certificates, invalid keys, mismatched pairs, expired certificates, and missing paths', async () => {
    const env = completeEnvironment();
    const invalidCert = await inspectNotificationReadiness({
      ...env,
      TOSS_MTLS_CERT_PATH: invalidCertificatePath,
    }, { appConfigPath });
    expect(invalidCert.providers.toss.mtls.status).toBe('invalid-certificate');

    const invalidKey = await inspectNotificationReadiness({
      ...env,
      TOSS_MTLS_KEY_PATH: invalidKeyPath,
    }, { appConfigPath });
    expect(invalidKey.providers.toss.mtls.status).toBe('invalid-key');

    const mismatch = await inspectNotificationReadiness({
      ...env,
      TOSS_MTLS_KEY_PATH: mismatchedKeyPath,
    }, { appConfigPath });
    expect(mismatch.providers.toss.mtls).toMatchObject({ status: 'mismatch', pairMatches: false });

    const validUntil = new X509Certificate(await readFile(certificatePath)).validTo;
    const expired = await inspectNotificationReadiness(env, {
      appConfigPath,
      now: Date.parse(validUntil) + 1,
    });
    expect(expired.providers.toss.mtls.status).toBe('expired');

    const missing = await inspectNotificationReadiness({
      ...env,
      TOSS_MTLS_CERT_PATH: join(fixtureDir, 'missing-cert.pem'),
    }, { appConfigPath });
    expect(missing.providers.toss.mtls).toMatchObject({
      status: 'incomplete',
      certificate: { status: 'missing' },
    });

    const unset = await inspectNotificationReadiness({
      ...env,
      TOSS_MTLS_CERT_PATH: '',
      TOSS_MTLS_KEY_PATH: '',
    }, { appConfigPath });
    expect(unset.providers.toss.mtls.status).toBe('not-configured');
  });

  it('returns non-ready status when an enabled provider has incomplete local configuration', async () => {
    const report = await inspectNotificationReadiness({
      MONGJIN_PUSH_ENABLED: '1',
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
    }, { appConfigPath });

    expect(report.overall.status).toBe('incomplete');
    expect(report.overall.requiredConfigurationComplete).toBe(false);
    expect(report.overall.unconfigured).toEqual(['toss']);
  });
});
