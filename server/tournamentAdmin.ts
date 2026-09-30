import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateTournamentSettings } from './tournamentRegistry';

interface AdminPlan { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }
export async function planTournamentAdmin(args: string[]): Promise<{ plan: AdminPlan; execute: boolean; baseUrl?: string }> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, days: { type: 'string' }, 'base-url': { type: 'string' }, execute: { type: 'boolean', default: false },
  } });
  if (positionals.length !== 1) throw new Error('COMMAND_REQUIRED');
  const command = positionals[0];
  let body: Record<string, unknown> | undefined;
  if (['publish', 'reward-status', 'notice'].includes(command)) {
    if (!values.file) throw new Error('FILE_REQUIRED');
    const bytes = await readFile(resolve(values.file));
    if (bytes.length > 65536) throw new Error('BODY_TOO_LARGE');
    body = JSON.parse(bytes.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_REQUEST');
  } else if (values.file) throw new Error('UNEXPECTED_FILE');
  let plan: AdminPlan;
  switch (command) {
    case 'publish': {
      const settings = validateTournamentSettings(body!);
      if (settings.startsAt <= Date.now() || settings.registrationEndsAt <= Date.now()) throw new Error('INVALID_SETTINGS');
      plan = { method: 'POST', path: '/admin/tournaments', body: settings as unknown as Record<string, unknown> }; break;
    }
    case 'status': plan = { method: 'GET', path: '/admin/tournaments' }; break;
    case 'analytics': {
      const days = values.days ?? '14';
      if (!['14', '28'].includes(days)) throw new Error('INVALID_DAYS');
      plan = { method: 'GET', path: `/admin/analytics?days=${days}` }; break;
    }
    case 'notifications': plan = { method: 'GET', path: '/admin/notifications' }; break;
    case 'rewards': plan = { method: 'GET', path: '/admin/rewards' }; break;
    case 'training-export': plan = { method: 'GET', path: '/admin/training-export' }; break;
    case 'reward-status':
      if (typeof body!.id !== 'string' || !body!.id || body!.id.length > 512 || !['pending', 'fulfilled'].includes(String(body!.status)) || Object.keys(body!).some(k => !['id', 'status'].includes(k))) throw new Error('INVALID_REQUEST');
      plan = { method: 'POST', path: '/admin/rewards', body }; break;
    case 'notice': {
      const allowed = ['id', 'title', 'body', 'playerIds', 'availableAt', 'expiresAt', 'tournamentId'];
      if (Object.keys(body!).some(k => !allowed.includes(k)) || typeof body!.title !== 'string' || !body!.title.trim() || body!.title.length > 100 || typeof body!.body !== 'string' || !body!.body.trim() || body!.body.length > 10000 ||
        body!.id !== undefined && (typeof body!.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body!.id)) ||
        body!.tournamentId !== undefined && (typeof body!.tournamentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body!.tournamentId)) ||
        body!.playerIds !== undefined && (!Array.isArray(body!.playerIds) || body!.playerIds.length > 10000 || body!.playerIds.some(id => typeof id !== 'string' || !id || id.length > 128))) throw new Error('INVALID_NOTICE');
      const available = body!.availableAt ?? Date.now(), expiry = body!.expiresAt;
      if (typeof available !== 'number' || !Number.isFinite(available) || expiry !== undefined && (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= available)) throw new Error('INVALID_NOTICE');
      plan = { method: 'POST', path: '/admin/notices', body }; break;
    }
    default: throw new Error('UNKNOWN_COMMAND');
  }
  if (values.days && command !== 'analytics') throw new Error('UNEXPECTED_DAYS');
  if (values['base-url']) {
    const base = new URL(values['base-url']);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:') || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('INVALID_BASE_URL');
  }
  return { plan, execute: values.execute!, baseUrl: values['base-url'] };
}
/** Import-safe CLI. Preview is the default; no store, database or network is opened during preview. */
export async function runTournamentAdmin(args: string[], deps: { env?: Record<string, string | undefined>; fetcher?: typeof fetch; output?: (text: string) => void } = {}): Promise<void> {
  const { plan, execute, baseUrl } = await planTournamentAdmin(args);
  const output = deps.output ?? console.log;
  output(JSON.stringify({ mode: execute ? 'execute' : 'preview', ...plan }, null, 2));
  if (!execute) return;
  if (!baseUrl) throw new Error('BASE_URL_REQUIRED');
  const token = (deps.env ?? process.env).MONGJIN_ADMIN_TOKEN;
  if (!token || token.length < 24) throw new Error('ADMIN_TOKEN_REQUIRED');
  const response = await (deps.fetcher ?? fetch)(new URL(plan.path, baseUrl), {
    method: plan.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: plan.body ? JSON.stringify(plan.body) : undefined, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`ADMIN_HTTP_${response.status}`);
  output(JSON.stringify(await response.json(), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runTournamentAdmin(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'ADMIN_COMMAND_FAILED';
    console.error(message); process.exitCode = 1;
  });
}
