import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { Move } from '../src/core/types';
import type { InboxMessage, InboxResponse, PlayerAchievement, PracticeReceipt } from '../src/net/inboxProtocol';
import type { CommunityChange, CommunityStore } from './communityStore';

export interface CommunityEvent {
  id: string; tournamentId: string; title: string; kind: string; occurredAt: number;
  playerIds: string[]; data: Record<string, unknown>;
}
export interface StoredNotice extends Omit<InboxMessage,'readAt'> {
  playerIds: string[] | null; availableAt: number; expiresAt: number | null;
}
export interface PushDevice { playerId: string; token: string; provider: 'expo'; updatedAt: string }
export interface PushJob { id: string; playerId: string; noticeId: string; tournamentId: string; kind: string; state: 'pending'|'accepted'|'skipped'|'failed'; attempts: number; nextAttemptAt: number; error?: string }
export interface TournamentReward { id: string; playerId: string; tournamentId: string; description: string; status: 'pending'|'fulfilled'; updatedAt: string }
interface PracticeSession { playerId: string; practiceId: string; moves: Move[]; modelVersion: string; createdAt: string; updatedAt: string; finished: boolean }
interface PracticeRecord { playerId: string; practiceId: string; moves: Move[]; reason: string; completed: boolean; recordedAt: string; modelVersion: string; rulesVersion: string }
interface AchievementRecord extends PlayerAchievement { playerId: string }
const sameMove = (a: Move,b: Move) => a.kind===b.kind && a.to.r===b.to.r && a.to.c===b.to.c && (a.kind==='PLACE' || b.kind==='MOVE' && a.from.r===b.from.r && a.from.c===b.from.c);
const prefix = (a: Move[],b: Move[]) => a.length<=b.length && a.every((move,i)=>sameMove(move,b[i]!));
const keyFor = (...parts:string[]) => JSON.stringify(parts);
const iso = (time=Date.now())=>new Date(time).toISOString();
function replay(moves: Move[]) {
  if (!Array.isArray(moves) || moves.length>512) throw new Error('INVALID_PRACTICE');
  let state=initialState(DEFAULT_CONFIG);
  for(const move of moves) {
    if (!move || !move.to || !Number.isInteger(move.to.r) || !Number.isInteger(move.to.c) ||
      (move.kind!=='PLACE' && move.kind!=='MOVE') ||
      (move.kind==='MOVE' && (!move.from || !Number.isInteger(move.from.r) || !Number.isInteger(move.from.c))) ||
      getResult(state,DEFAULT_CONFIG) || !legalMoves(state,DEFAULT_CONFIG).some(m=>sameMove(m,move))) throw new Error('INVALID_PRACTICE');
    state=applyMove(state,move);
  }
  return state;
}
export class CommunityService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly store: CommunityStore, private readonly now:()=>number=Date.now) {}
  private serial<T>(fn:()=>Promise<T>):Promise<T> {
    const run=this.tail.then(fn); this.tail=run.catch(()=>undefined); return run;
  }
  async inbox(playerId:string):Promise<InboxResponse> {
    const notices=await this.store.list<StoredNotice>('notices');
    const read=await this.store.list<{playerId:string;noticeId:string;readAt:string}>('reads');
    const readMap=new Map(read.filter(x=>x.playerId===playerId).map(x=>[x.noticeId,x.readAt]));
    const time=this.now();
    const all=notices.filter(n=>n.availableAt<=time && (n.expiresAt===null || n.expiresAt>time) && (n.playerIds===null || n.playerIds.includes(playerId)))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    return { messages:all.slice(0,200).map(n=>({id:n.id,kind:n.kind,title:n.title,body:n.body,createdAt:n.createdAt,tournamentId:n.tournamentId,readAt:readMap.get(n.id)??null})), unreadCount:all.filter(n=>!readMap.has(n.id)).length };
  }
  async markRead(playerId:string,id:string) {
    const item=await this.store.get<StoredNotice>('notices',id);
    if(!item || item.availableAt>this.now() || item.expiresAt!==null && item.expiresAt<=this.now() || item.playerIds!==null && !item.playerIds.includes(playerId)) throw new Error('NOT_FOUND');
    const key=keyFor(playerId,id);
    await this.serial(async()=>{
      if(!await this.store.get('reads',key)) await this.store.commit([{namespace:'reads',key,value:{playerId,noticeId:id,readAt:iso(this.now())}}]);
    });
    return this.inbox(playerId);
  }
  async publishNotice(input:{id?:string;title:string;body:string;playerIds?:string[];availableAt?:number;expiresAt?:number;tournamentId?:string}) {
    const title=typeof input.title==='string'?input.title.trim():'',body=typeof input.body==='string'?input.body.trim():'';
    if(!title || title.length>100 || !body || body.length>10000) throw new Error('INVALID_NOTICE');
    if(input.playerIds && (!Array.isArray(input.playerIds) || input.playerIds.length>10000 || input.playerIds.some(id=>typeof id!=='string' || !id || id.length>128))) throw new Error('INVALID_NOTICE');
    const availableAt=input.availableAt??this.now(),expiresAt=input.expiresAt??null;
    if(!Number.isFinite(availableAt) || expiresAt!==null && (!Number.isFinite(expiresAt) || expiresAt<=availableAt)) throw new Error('INVALID_NOTICE');
    const notice:StoredNotice={id:input.id??randomUUID(),kind:'notice',title,body,createdAt:iso(this.now()),playerIds:input.playerIds??null,availableAt,expiresAt,tournamentId:input.tournamentId??null};
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(notice.id)) throw new Error('INVALID_NOTICE');
    await this.store.commit([{namespace:'notices',key:notice.id,value:notice}]);
    return {id:notice.id};
  }
  async preferences(playerId:string,value?:boolean) {
    if(value!==undefined) await this.store.commit([{namespace:'preferences',key:playerId,value:{playerId,tournamentReminders:value,updatedAt:iso(this.now())}}]);
    const saved=await this.store.get<{tournamentReminders:boolean}>('preferences',playerId);
    return {tournamentReminders:saved?.tournamentReminders??false};
  }
  async registerDevice(playerId:string,token:string,enabled=true) {
    if(!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token) || token.length>300) throw new Error('INVALID_TOKEN');
    const value:PushDevice={playerId,token,provider:'expo',updatedAt:iso(this.now())};
    // Token ownership is replaced atomically when an installation changes account.
    await this.serial(async()=>{
      const current=await this.store.get<PushDevice>('devices',token);
      if(!enabled && current && current.playerId!==playerId) return;
      await this.store.commit([{namespace:'devices',key:token,value:enabled?value:null}]);
    });
    return {registered:enabled};
  }
  async achievements(playerId:string):Promise<PlayerAchievement[]> {
    const all=await this.store.list<AchievementRecord>('achievements');
    return all.filter(x=>x.playerId===playerId).map(({id,title,tournamentId,earnedAt})=>({id,title,tournamentId,earnedAt}));
  }
  consumeEvent(event:CommunityEvent):Promise<void> {
    return this.serial(async()=>{
      const eventKey=keyFor(event.tournamentId,event.id);
      if(await this.store.get('events',eventKey)) return;
      const changes:CommunityChange[]=[{namespace:'events',key:eventKey,value:event}];
      const copy=this.eventCopy(event);
      if(copy && event.playerIds.length) {
        const id=`tournament:${event.tournamentId}:${event.id}`;
        const notice:StoredNotice={id,kind:event.kind==='champion'?'achievement':'tournament',title:copy.title,body:copy.body,createdAt:iso(event.occurredAt),playerIds:[...new Set(event.playerIds)],availableAt:event.occurredAt,expiresAt:null,tournamentId:event.tournamentId};
        changes.push({namespace:'notices',key:id,value:notice});
        for(const playerId of notice.playerIds!) {
          if(['confirmed','cancelled','reminder','started','finished','champion'].includes(event.kind) && (await this.preferences(playerId)).tournamentReminders) {
            const job:PushJob={id:keyFor(eventKey,playerId),playerId,noticeId:id,tournamentId:event.tournamentId,kind:event.kind,state:'pending',attempts:0,nextAttemptAt:this.now()};
            changes.push({namespace:'pushJobs',key:job.id,value:job});
          }
          if(event.kind==='champion') {
            const title=typeof event.data.championTitle==='string'?event.data.championTitle:typeof event.data.title==='string'?event.data.title:null;
            // Only the server's explicit achievement text can become a permanent title.
            if(title) {
              const id=keyFor(event.tournamentId,playerId,'champion');
              changes.push({namespace:'achievements',key:id,value:{id,playerId,title,tournamentId:event.tournamentId,earnedAt:iso(event.occurredAt)}});
              if(typeof event.data.rewardDescription==='string' && event.data.rewardDescription.trim()) {
                const reward:TournamentReward={id,playerId,tournamentId:event.tournamentId,description:event.data.rewardDescription,status:'pending',updatedAt:iso(event.occurredAt)};
                changes.push({namespace:'rewards',key:id,value:reward});
              }
            }
          }
        }
      }
      await this.store.commit(changes);
    });
  }
  private eventCopy(event:CommunityEvent):{title:string;body:string}|null {
    const start=typeof event.data.startsAt==='number'?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(event.data.startsAt):'';
    switch(event.kind) {
      case 'register':return {title:'대회 참가 신청',body:`${event.title}\n참가 신청을 기록했습니다.${start?'\n'+start+' 시작':''}`};
      case 'confirmed':return {title:'대회 개최 확정',body:`${event.title}\n${start?start+' 시작\n':''}대회 시간 내 자유롭게 참가할 수 있습니다.`};
      case 'cancelled': {
        const next=event.data.nextTournament as {startsAt?:number;title?:string}|undefined;
        const nextText=next?.startsAt ? new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(next.startsAt):null;
        return {title:'대회 취소',body:`${event.title}는 참가 인원 부족으로 열리지 않습니다.${nextText?`\n다음 대회: ${next?.title??'천하제일몽진대회'} ${nextText}`:'\n다음 일정이 정해지면 안내합니다.'}`};
      }
      case 'reminder':return {title:'대회 시작 안내',body:`${event.title}\n${start?start+' 시작':'대회가 1시간 뒤 시작됩니다.'}`};
      case 'started':return {title:'대회 시작',body:`${event.title}가 시작되었습니다. 대회 시간 내 자유롭게 참가할 수 있습니다.`};
      case 'finished':return {title:'대회 결과',body:`${event.title}가 종료되었습니다. 최종 순위를 확인할 수 있습니다.`};
      case 'champion':return {title:'우승 칭호',body:`${event.title} 우승을 기록했습니다. 내 정보에서 칭호를 확인할 수 있습니다.`};
      default:return null;
    }
  }
  async beforePractice(playerId:string,practiceId:string,moves:Move[]):Promise<Move|null> {
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(practiceId)) throw new Error('INVALID_PRACTICE');
    const state=replay(moves);
    if(state.turn!=='WHITE' || getResult(state,DEFAULT_CONFIG)) throw new Error('INVALID_PRACTICE');
    const session=await this.store.get<PracticeSession>('practiceSessions',keyFor(playerId,practiceId));
    if(!session) { if(moves.length!==1) throw new Error('INVALID_PRACTICE'); return null; }
    if(session.finished) throw new Error('PRACTICE_FINISHED');
    // A human move can be saved while inference is still running. Resume that
    // exact request without accepting a client-created AI move.
    if(session.moves.length%2===1 && moves.length===session.moves.length && prefix(moves,session.moves)) return null;
    if(moves.length===session.moves.length-1 && prefix(moves,session.moves)) return session.moves.at(-1)!;
    if(moves.length!==session.moves.length+1 || !prefix(session.moves,moves)) throw new Error('INVALID_PRACTICE');
    return null;
  }
  savePracticeMove(playerId:string,practiceId:string,moves:Move[],move:Move,modelVersion:string):Promise<void> {
    return this.serial(async()=>{
      await this.beforePractice(playerId,practiceId,moves);
      const key=keyFor(playerId,practiceId);
      const old=await this.store.get<PracticeSession>('practiceSessions',key);
      const full=[...moves,move]; replay(full);
      const value:PracticeSession={playerId,practiceId,moves:full,modelVersion,createdAt:old?.createdAt??iso(this.now()),updatedAt:iso(this.now()),finished:false};
      await this.store.commit([{namespace:'practiceSessions',key,value}]);
    });
  }
  finishPractice(playerId:string,practiceId:string,moves:Move[],reason:'completed'|'interrupted'|'resign'):Promise<PracticeReceipt> {
    return this.serial(async()=>{
      const key=keyFor(playerId,practiceId);
      const prior=await this.store.get<PracticeRecord>('practiceRecords',key);
      if(!['completed','interrupted','resign'].includes(reason)) throw new Error('INVALID_PRACTICE');
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(practiceId)) throw new Error('INVALID_PRACTICE');
      replay(moves);
      let session=await this.store.get<PracticeSession>('practiceSessions',key);
      if(!session) {
        if(reason==='completed' || moves.length!==1) throw new Error('INVALID_PRACTICE');
        session={playerId,practiceId,moves,modelVersion:'not-yet-inferred',createdAt:iso(this.now()),updatedAt:iso(this.now()),finished:false};
      }
      const extendsSession=prefix(session.moves,moves) && moves.length<=session.moves.length+1;
      const missingReply=reason==='interrupted' && moves.length===session.moves.length-1 && prefix(moves,session.moves);
      if(!extendsSession && !missingReply) throw new Error('INVALID_PRACTICE');
      // If pairing overtook an AI response, retain the server-verified reply.
      // The client will receive this same cached move when it resumes training.
      const verifiedMoves=missingReply?session.moves:moves;
      const state=replay(verifiedMoves);
      const ended=Boolean(getResult(state,DEFAULT_CONFIG));
      if(reason==='completed' && !ended) throw new Error('INVALID_PRACTICE');
      const completed=ended || reason==='resign' && moves.length>=2;
      if(!prior?.completed) {
        const record:PracticeRecord={playerId,practiceId,moves:verifiedMoves,reason,completed,recordedAt:iso(this.now()),modelVersion:session.modelVersion,rulesVersion:'mongjin-core-1'};
        await this.store.commit([{namespace:'practiceRecords',key,value:record},{namespace:'practiceSessions',key,value:{...session,moves:verifiedMoves,updatedAt:iso(this.now()),finished:completed||reason==='resign'}}]);
      }
      const all=await this.store.list<PracticeRecord>('practiceRecords');
      return {saved:true,completed:Boolean(prior?.completed||completed),completedCount:all.filter(x=>x.playerId===playerId && x.completed).length};
    });
  }
}
