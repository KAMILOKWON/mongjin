import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectNotificationReadiness } from './notificationReadiness';

export async function runNotificationReadinessCheck(): Promise<void> {
  const report = await inspectNotificationReadiness(process.env);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.overall.requiredConfigurationComplete ? 0 : 1;
}

async function runSafely(): Promise<void> {
  try {
    await runNotificationReadinessCheck();
  } catch {
    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      networkChecksPerformed: false,
      overall: { status: 'incomplete', requiredConfigurationComplete: false, unconfigured: ['check-failed'] },
    }, null, 2) + '\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void runSafely();
}
