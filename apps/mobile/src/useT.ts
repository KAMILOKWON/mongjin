import { useAppStore } from './store';
import { dict, type Dict } from './i18n';

export function useT(): Dict {
  const lang = useAppStore((state) => state.lang);
  return dict(lang);
}
