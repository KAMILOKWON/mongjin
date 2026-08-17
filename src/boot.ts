import { useMobileShell } from './mobile/detect';

const mobile = useMobileShell();
document.documentElement.classList.toggle('m-shell', mobile);
void (mobile ? import('./mobile/main') : import('./main'));
