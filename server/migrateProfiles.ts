import { resolve } from 'node:path';
import { PostgresProfileRepository, loadProfilesForMigration } from './profileRepository';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL이 필요합니다');

const sourcePath = resolve(process.argv[2] ?? process.env.MONGJIN_PROFILE_DATA_FILE ?? './data/profiles.json');
const profiles = loadProfilesForMigration(sourcePath);
const repository = new PostgresProfileRepository(connectionString);

try {
  await repository.initialize();
  const imported = await repository.importProfiles(profiles);
  const total = (await repository.loadProfiles()).length;
  console.log(`프로필 마이그레이션 완료 — 원본 ${profiles.length}명, 새로 가져온 ${imported}명, DB 전체 ${total}명`);
} finally {
  await repository.close();
}
