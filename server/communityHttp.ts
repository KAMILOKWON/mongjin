import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import type { Move } from '../src/core/types';
import { CommunityService } from './community';

export class HttpError extends Error { constructor(readonly status:number,code:string){super(code);} }
export async function readCommunityJson(req:IncomingMessage):Promise<Record<string,unknown>> {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req) {
    size+=chunk.length;
    if(size>65536) throw new HttpError(413,'BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!body || typeof body!=='object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400,'INVALID_REQUEST'); }
}
export function communityReply(res:ServerResponse,status:number,body:unknown) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}
export function hasAdminAuthorization(req:IncomingMessage,secret=process.env.MONGJIN_ADMIN_TOKEN):boolean {
  if(!secret || secret.length<24) return false;
  const input=Buffer.from(req.headers.authorization??'');
  const expected=Buffer.from(`Bearer ${secret}`);
  return input.length===expected.length && timingSafeEqual(input,expected);
}
export function createCommunityHandler(service:CommunityService,authorize:(playerId:string,token:string)=>boolean) {
  const paths=new Set(['/inbox','/inbox/read','/achievements','/notifications/preferences','/notifications/device','/tournament/practice-record','/admin/notices']);
  return async (req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const path=req.url?.split('?')[0]??'';
    if(!paths.has(path)) return false;
    try {
      if(req.method!=='POST') throw new HttpError(405,'METHOD_NOT_ALLOWED');
      if(path==='/admin/notices' && !hasAdminAuthorization(req)) throw new HttpError(401,'NOT_AUTHORIZED');
      const body=await readCommunityJson(req);
      if(path==='/admin/notices') {
        const result=await service.publishNotice(body as unknown as Parameters<CommunityService['publishNotice']>[0]);
        communityReply(res,200,result);return true;
      }
      const {playerId,token}=body;
      if(typeof playerId!=='string' || typeof token!=='string' || !authorize(playerId,token)) throw new HttpError(401,'NOT_AUTHENTICATED');
      let result:unknown;
      switch(path) {
        case '/inbox':result=await service.inbox(playerId);break;
        case '/inbox/read':
          if(typeof body.id!=='string') throw new HttpError(400,'INVALID_REQUEST');
          result=await service.markRead(playerId,body.id);break;
        case '/achievements':result={achievements:await service.achievements(playerId)};break;
        case '/notifications/preferences':
          if(body.tournamentReminders!==undefined && typeof body.tournamentReminders!=='boolean') throw new HttpError(400,'INVALID_REQUEST');
          result=await service.preferences(playerId,body.tournamentReminders as boolean|undefined);break;
        case '/notifications/device':
          if(typeof body.tokenValue!=='string' || body.enabled!==undefined && typeof body.enabled!=='boolean') throw new HttpError(400,'INVALID_REQUEST');
          result=await service.registerDevice(playerId,body.tokenValue,body.enabled!==false);break;
        case '/tournament/practice-record':
          if(typeof body.practiceId!=='string' || !Array.isArray(body.moves) || typeof body.reason!=='string') throw new HttpError(400,'INVALID_REQUEST');
          result=await service.finishPractice(playerId,body.practiceId,body.moves as Move[],body.reason as 'completed'|'interrupted'|'resign');break;
      }
      communityReply(res,200,result);
    } catch(error) {
      const code=error instanceof Error ? error.message : 'INTERNAL_ERROR';
      const known=['INVALID_REQUEST','INVALID_NOTICE','INVALID_TOKEN','INVALID_PRACTICE','PRACTICE_FINISHED'];
      const status=error instanceof HttpError?error.status:code==='NOT_FOUND'?404:known.includes(code)?400:500;
      communityReply(res,status,{error:status===500?'INTERNAL_ERROR':code});
    }
    return true;
  };
}
