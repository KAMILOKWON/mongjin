import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('studioPlatform', Object.freeze({ name: 'steam' }));
