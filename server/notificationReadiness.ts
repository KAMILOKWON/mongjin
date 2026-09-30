import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_NAMES = ['CONFIRMED', 'CANCELLED', 'REMINDER', 'STARTED', 'FINISHED', 'CHAMPION'] as const;
const MAX_SECRET_FILE_BYTES = 256 * 1024;
const MAX_APP_CONFIG_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/mobile/app.json');

type ReadFailure = 'missing' | 'unreadable' | 'not-a-file' | 'too-large';
type ReadResult = { status: 'readable'; contents: Buffer } | { status: ReadFailure };
type ConfigFileStatus = ReadFailure | 'readable' | 'invalid';
type ProviderStatus = 'disabled' | 'configured-unverified' | 'incomplete';
type MtlsStatus =
  | 'not-configured'
  | 'incomplete'
  | 'invalid-certificate'
  | 'invalid-key'
  | 'invalid-material'
  | 'mismatch'
  | 'not-yet-valid'
  | 'expired'
  | 'valid';

export interface NotificationReadinessReport {
  schemaVersion: 1;
  networkChecksPerformed: false;
  flags: {
    tournamentPushEnabled: boolean;
    matchPushEnabled: boolean;
  };
  providers: {
    toss: {
      requested: boolean;
      status: ProviderStatus;
      inferredReadiness: 'inferred-ready' | 'incomplete';
      externalVerification: 'not-performed';
      templateApprovalVerification: 'unavailable';
      templates: Record<(typeof TEMPLATE_NAMES)[number], { configured: boolean }>;
      mtls: {
        status: MtlsStatus;
        certificate: {
          status: 'not-configured' | ReadFailure | 'not-checked' | 'invalid' | 'parsed';
          validFrom: string | null;
          validTo: string | null;
        };
        privateKey: { status: 'not-configured' | ReadFailure | 'not-checked' | 'invalid' | 'parsed' };
        pairMatches: boolean | null;
      };
    };
    expo: {
      requested: boolean;
      status: ProviderStatus;
      projectId: {
        status: 'missing' | 'invalid' | 'valid';
        source: 'missing' | 'environment' | 'app-config';
      };
      appConfigStatus: ConfigFileStatus;
      androidGoogleServicesFileStatus: 'not-configured' | ReadFailure | 'invalid' | 'configured';
      accessTokenConfigured: boolean;
      credentialVerification: 'external-unavailable';
      providerKeys: {
        fcmV1: {
          configuration: 'not-inspected';
          readiness: 'unverified';
          externalVerification: 'unavailable';
        };
        apns: {
          configuration: 'not-inspected';
          readiness: 'unverified';
          externalVerification: 'unavailable';
        };
      };
    };
    liveActivityApns: {
      optional: true;
      configurationSupplied: boolean;
      localReadiness: 'not-configured' | 'incomplete' | 'inferred-ready';
      externalVerification: 'unavailable';
      keyFileStatus: 'not-configured' | ReadFailure | 'invalid' | 'unsupported-key' | 'valid';
      keyIdConfigured: boolean;
      teamIdConfigured: boolean;
      bundleIdConfigured: boolean;
      environment: 'sandbox' | 'production' | 'invalid';
    };
  };
  overall: {
    status: 'disabled' | 'configured-unverified' | 'incomplete';
    requiredConfigurationComplete: boolean;
    unconfigured: string[];
  };
}

export interface ReadinessOptions {
  appConfigPath?: string;
  now?: number;
}

async function readBoundedFile(path: string | undefined, maxBytes: number): Promise<ReadResult> {
  if (!path?.trim()) return { status: 'missing' };
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return { status: 'not-a-file' };
    if (metadata.size > maxBytes) return { status: 'too-large' };
    const contents = await readFile(path);
    if (contents.byteLength > maxBytes) return { status: 'too-large' };
    return { status: 'readable', contents };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
}

function toIsoDate(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function inspectTossMtls(
  env: Record<string, string | undefined>,
  now: number,
): Promise<NotificationReadinessReport['providers']['toss']['mtls']> {
  const certPath = env.TOSS_MTLS_CERT_PATH?.trim();
  const keyPath = env.TOSS_MTLS_KEY_PATH?.trim();
  const certificateRead = await readBoundedFile(certPath, MAX_SECRET_FILE_BYTES);
  const keyRead = await readBoundedFile(keyPath, MAX_SECRET_FILE_BYTES);
  const certificate: NotificationReadinessReport['providers']['toss']['mtls']['certificate'] = {
    status: !certPath ? 'not-configured' as const
      : certificateRead.status === 'readable' ? 'not-checked' as const
        : certificateRead.status,
    validFrom: null as string | null,
    validTo: null as string | null,
  };
  const privateKey: NotificationReadinessReport['providers']['toss']['mtls']['privateKey'] = {
    status: !keyPath ? 'not-configured' as const
      : keyRead.status === 'readable' ? 'not-checked' as const
        : keyRead.status,
  };
  const pairMatches = null as boolean | null;

  if (!certPath || !keyPath) {
    return { status: 'not-configured', certificate, privateKey, pairMatches };
  }
  if (certificateRead.status !== 'readable' || keyRead.status !== 'readable') {
    return { status: 'incomplete', certificate, privateKey, pairMatches };
  }

  let parsedCertificate: X509Certificate;
  try {
    parsedCertificate = new X509Certificate(certificateRead.contents);
  } catch {
    certificate.status = 'invalid';
    return { status: 'invalid-certificate', certificate, privateKey, pairMatches };
  }

  const validFrom = toIsoDate(parsedCertificate.validFrom);
  const validTo = toIsoDate(parsedCertificate.validTo);
  if (!validFrom || !validTo) {
    certificate.status = 'invalid';
    return { status: 'invalid-certificate', certificate, privateKey, pairMatches };
  }
  certificate.status = 'parsed';
  certificate.validFrom = validFrom;
  certificate.validTo = validTo;

  let parsedKey;
  try {
    parsedKey = createPrivateKey(keyRead.contents);
  } catch {
    privateKey.status = 'invalid';
    return { status: 'invalid-key', certificate, privateKey, pairMatches };
  }
  privateKey.status = 'parsed';

  if (!parsedCertificate.checkPrivateKey(parsedKey)) {
    return { status: 'mismatch', certificate, privateKey, pairMatches: false };
  }

  try {
    createSecureContext({ cert: certificateRead.contents, key: keyRead.contents });
  } catch {
    return { status: 'invalid-material', certificate, privateKey, pairMatches: true };
  }

  const notBefore = Date.parse(parsedCertificate.validFrom);
  const notAfter = Date.parse(parsedCertificate.validTo);
  if (now < notBefore) return { status: 'not-yet-valid', certificate, privateKey, pairMatches: true };
  if (now >= notAfter) return { status: 'expired', certificate, privateKey, pairMatches: true };
  return { status: 'valid', certificate, privateKey, pairMatches: true };
}

async function inspectAppConfig(path: string): Promise<{
  status: ConfigFileStatus;
  projectId?: unknown;
  googleServicesFile?: string;
}> {
  const file = await readBoundedFile(path, MAX_APP_CONFIG_BYTES);
  if (file.status !== 'readable') return { status: file.status };
  try {
    const parsed: unknown = JSON.parse(file.contents.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 'invalid' };
    const expo = (parsed as Record<string, unknown>).expo;
    if (typeof expo !== 'object' || expo === null || Array.isArray(expo)) return { status: 'invalid' };
    const expoObject = expo as Record<string, unknown>;
    const android = expoObject.android;
    const googleServicesFile = typeof android === 'object' && android !== null && !Array.isArray(android)
      ? (android as Record<string, unknown>).googleServicesFile
      : undefined;
    const extra = expoObject.extra;
    if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
      return {
        status: 'readable',
        googleServicesFile: typeof googleServicesFile === 'string' ? googleServicesFile : undefined,
      };
    }
    const eas = (extra as Record<string, unknown>).eas;
    if (typeof eas !== 'object' || eas === null || Array.isArray(eas)) {
      return {
        status: 'readable',
        googleServicesFile: typeof googleServicesFile === 'string' ? googleServicesFile : undefined,
      };
    }
    return {
      status: 'readable',
      projectId: (eas as Record<string, unknown>).projectId,
      googleServicesFile: typeof googleServicesFile === 'string' ? googleServicesFile : undefined,
    };
  } catch {
    return { status: 'invalid' };
  }
}

async function inspectGoogleServicesFile(appConfigPath: string, configuredPath: string | undefined) {
  if (!configuredPath?.trim()) return 'not-configured' as const;
  const file = await readBoundedFile(resolve(dirname(appConfigPath), configuredPath), MAX_APP_CONFIG_BYTES);
  if (file.status !== 'readable') return file.status;
  try {
    const parsed: unknown = JSON.parse(file.contents.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid' as const;
    const root = parsed as Record<string, unknown>;
    const projectInfo = root.project_info;
    const clients = root.client;
    if (typeof projectInfo !== 'object' || projectInfo === null || Array.isArray(projectInfo)
      || typeof (projectInfo as Record<string, unknown>).project_id !== 'string'
      || !(projectInfo as Record<string, unknown>).project_id
      || !Array.isArray(clients) || clients.length === 0) {
      return 'invalid' as const;
    }
    return 'configured' as const;
  } catch {
    return 'invalid' as const;
  }
}

function isValidBundleId(value: string): boolean {
  return value.split('.').length >= 2
    && value.split('.').every(part => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part));
}

async function inspectLiveActivityApns(
  env: Record<string, string | undefined>,
): Promise<NotificationReadinessReport['providers']['liveActivityApns']> {
  const keyPath = env.MONGJIN_APNS_KEY_PATH?.trim();
  const keyRead = await readBoundedFile(keyPath, MAX_SECRET_FILE_BYTES);
  let keyFileStatus: NotificationReadinessReport['providers']['liveActivityApns']['keyFileStatus'] =
    !keyPath ? 'not-configured' : keyRead.status === 'readable' ? 'invalid' : keyRead.status;
  let validP256Key = false;

  if (keyRead.status === 'readable') {
    try {
      const key = createPrivateKey(keyRead.contents);
      validP256Key = key.asymmetricKeyType === 'ec'
        && (key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
          || key.asymmetricKeyDetails?.namedCurve === 'P-256');
      keyFileStatus = validP256Key ? 'valid' : 'unsupported-key';
    } catch {
      keyFileStatus = 'invalid';
    }
  }

  const keyId = env.MONGJIN_APNS_KEY_ID?.trim() ?? '';
  const teamId = env.MONGJIN_APNS_TEAM_ID?.trim() ?? '';
  const bundleId = env.MONGJIN_APNS_BUNDLE_ID?.trim() ?? '';
  const rawEnvironment = env.MONGJIN_APNS_ENVIRONMENT?.trim() ?? '';
  const environment: NotificationReadinessReport['providers']['liveActivityApns']['environment'] =
    !rawEnvironment || rawEnvironment === 'production'
      ? 'production'
      : rawEnvironment === 'sandbox' ? 'sandbox' : 'invalid';
  const keyIdConfigured = /^[A-Za-z0-9]{10}$/.test(keyId);
  const teamIdConfigured = /^[A-Za-z0-9]{10}$/.test(teamId);
  const bundleIdConfigured = isValidBundleId(bundleId);
  const configured = validP256Key && keyIdConfigured && teamIdConfigured
    && bundleIdConfigured && environment !== 'invalid';
  const configurationSupplied = Boolean(keyPath || keyId || teamId || bundleId || rawEnvironment);

  return {
    optional: true,
    configurationSupplied,
    localReadiness: configured ? 'inferred-ready' : configurationSupplied ? 'incomplete' : 'not-configured',
    externalVerification: 'unavailable',
    keyFileStatus,
    keyIdConfigured,
    teamIdConfigured,
    bundleIdConfigured,
    environment,
  };
}

export async function inspectNotificationReadiness(
  env: Record<string, string | undefined> = process.env,
  options: ReadinessOptions = {},
): Promise<NotificationReadinessReport> {
  const tournamentPushEnabled = env.MONGJIN_PUSH_ENABLED === '1';
  const matchPushEnabled = env.MONGJIN_MATCH_PUSH_ENABLED === '1';
  const tossRequested = tournamentPushEnabled;
  const expoRequested = tournamentPushEnabled || matchPushEnabled;
  const appConfigPath = options.appConfigPath ?? APP_CONFIG_PATH;
  const appConfig = await inspectAppConfig(appConfigPath);
  const environmentProjectId = env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  const appConfigProjectId = typeof appConfig.projectId === 'string' ? appConfig.projectId.trim() : '';
  const projectId = appConfigProjectId || environmentProjectId;
  const projectIdSource: NotificationReadinessReport['providers']['expo']['projectId']['source'] =
    appConfigProjectId ? 'app-config' : environmentProjectId ? 'environment' : 'missing';
  const projectIdStatus: NotificationReadinessReport['providers']['expo']['projectId']['status'] =
    !projectId ? 'missing' : UUID_PATTERN.test(projectId) ? 'valid' : 'invalid';
  const googleServicesFileStatus = await inspectGoogleServicesFile(appConfigPath, appConfig.googleServicesFile);

  const templateEntries = TEMPLATE_NAMES.map(name => [
    name,
    { configured: Boolean(env['MONGJIN_TOSS_TEMPLATE_' + name]?.trim()) },
  ] as const);
  const templates = Object.fromEntries(templateEntries) as NotificationReadinessReport['providers']['toss']['templates'];
  const mtls = await inspectTossMtls(env, options.now ?? Date.now());
  const tossConfigured = Object.values(templates).every(template => template.configured) && mtls.status === 'valid';
  const toss: NotificationReadinessReport['providers']['toss'] = {
    requested: tossRequested,
    status: !tossRequested ? 'disabled' : tossConfigured ? 'configured-unverified' : 'incomplete',
    inferredReadiness: tossConfigured ? 'inferred-ready' : 'incomplete',
    externalVerification: 'not-performed',
    templateApprovalVerification: 'unavailable',
    templates,
    mtls,
  };

  const expoConfigured = projectIdStatus === 'valid' && googleServicesFileStatus === 'configured';
  const expo: NotificationReadinessReport['providers']['expo'] = {
    requested: expoRequested,
    status: !expoRequested ? 'disabled' : expoConfigured ? 'configured-unverified' : 'incomplete',
    projectId: { status: projectIdStatus, source: projectIdSource },
    appConfigStatus: appConfig.status,
    androidGoogleServicesFileStatus: googleServicesFileStatus,
    accessTokenConfigured: Boolean(env.EXPO_ACCESS_TOKEN?.trim()),
    credentialVerification: 'external-unavailable',
    providerKeys: {
      fcmV1: {
        configuration: 'not-inspected',
        readiness: 'unverified',
        externalVerification: 'unavailable',
      },
      apns: {
        configuration: 'not-inspected',
        readiness: 'unverified',
        externalVerification: 'unavailable',
      },
    },
  };

  const liveActivityApns = await inspectLiveActivityApns(env);
  const unconfigured: string[] = [];
  if (tossRequested && !tossConfigured) unconfigured.push('toss');
  if (expoRequested && projectIdStatus !== 'valid') unconfigured.push('expo-project-id');
  if (expoRequested && googleServicesFileStatus !== 'configured') unconfigured.push('expo-android-google-services');
  const requiredConfigurationComplete = unconfigured.length === 0;
  const anyProviderRequested = tournamentPushEnabled || matchPushEnabled;

  return {
    schemaVersion: 1,
    networkChecksPerformed: false,
    flags: { tournamentPushEnabled, matchPushEnabled },
    providers: { toss, expo, liveActivityApns },
    overall: {
      status: !anyProviderRequested
        ? 'disabled'
        : requiredConfigurationComplete ? 'configured-unverified' : 'incomplete',
      requiredConfigurationComplete,
      unconfigured,
    },
  };
}
