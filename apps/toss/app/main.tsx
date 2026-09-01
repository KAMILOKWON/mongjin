import { createRoot } from 'react-dom/client';
import { migrateSdk3Storage } from '@shared/platform/migrateSdk3Storage';

async function bootstrap() {
  await migrateSdk3Storage();
  // GameController가 저장소를 hydrate하기 전에 Origin 이전을 끝낸다.
  const { App } = await import('./App');
  createRoot(document.getElementById('app')!).render(<App />);
}

void bootstrap();
