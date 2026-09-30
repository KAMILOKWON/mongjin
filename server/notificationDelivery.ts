import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { CommunityService, PushDevice, PushJob, StoredNotice } from './community';

interface DeliveryReceipt { id:string;jobId:string;token:string;ticketId:string;createdAt:number;checkedAt:number|null;status:'accepted'|'delivered'|'failed'|'unknown';error?:string }
interface ProviderReply {status:'ok'|'error';id?:string;details?:{error?:string}}
export class NotificationDelivery {
  private working=false;
  constructor(private readonly service:CommunityService,private readonly getTossUserKey:(playerId:string)=>number|string|undefined,private readonly env:Record<string,string|undefined>=process.env,private readonly fetcher:typeof fetch=fetch,private readonly tossRequester:typeof request=request) {}
  async flush() {
    if(this.working || this.env.MONGJIN_PUSH_ENABLED!=='1') return;
    this.working=true;
    try {
      const jobs=await this.service.store.list<PushJob>('pushJobs');
      for(const job of jobs.filter(j=>j.state==='pending' && j.nextAttemptAt<=Date.now()).slice(0,30)) await this.deliver(job);
      await this.checkReceipts();
    } finally {this.working=false;}
  }
  private async deliver(job:PushJob) {
    const notice=await this.service.store.get<StoredNotice>('notices',job.noticeId);
    const prefs=await this.service.preferences(job.playerId);
    if(!notice || !prefs.tournamentReminders || await this.isObsolete(job)) {
      await this.save({...job,state:'skipped',error:!prefs.tournamentReminders?'OPTED_OUT':'OBSOLETE'});return;
    }
    try {
      const userKey=this.getTossUserKey(job.playerId);
      if(userKey!==undefined) await this.sendToss(job,notice,String(userKey));
      else {
        const devices=(await this.service.store.list<PushDevice>('devices')).filter(d=>d.playerId===job.playerId);
        if(!devices.length) {await this.save({...job,state:'skipped',error:'NO_DEVICE'});return;}
        // Individual receipts stop a partially failed multi-device send duplicating successful targets.
        for(const device of devices) await this.sendExpo(job,notice,device.token);
      }
      await this.save({...job,state:'accepted',attempts:job.attempts+1});
    } catch {
      const attempts=job.attempts+1;
      await this.save({...job,state:attempts>=5?'failed':'pending',attempts,nextAttemptAt:Date.now()+Math.min(3600000,30000*2**attempts),error:'DELIVERY_FAILED'});
    }
  }
  private async isObsolete(job:PushJob) {
    if(!['confirmed','reminder','started'].includes(job.kind)) return false;
    const events=await this.service.store.list<{tournamentId:string;kind:string;data:Record<string,unknown>}>('events');
    return events.some(e=>{
      if(e.tournamentId!==job.tournamentId) return false;
      if(e.kind==='cancelled'||e.kind==='finished') return true;
      if(['confirmed','reminder'].includes(job.kind) && typeof e.data.startsAt==='number' && Date.now()>=e.data.startsAt) return true;
      return job.kind==='started' && typeof e.data.endsAt==='number' && Date.now()>=e.data.endsAt;
    });
  }
  private save(job:PushJob){return this.service.store.commit([{namespace:'pushJobs',key:job.id,value:job}]);}
  private async sendExpo(job:PushJob,notice:StoredNotice,token:string) {
    const receiptKey=JSON.stringify([job.id,token]);
    if(await this.service.store.get('pushReceipts',receiptKey)) return;
    const response=await this.fetcher('https://exp.host/--/api/v2/push/send',{method:'POST',headers:{'Content-Type':'application/json',...(this.env.EXPO_ACCESS_TOKEN?{Authorization:`Bearer ${this.env.EXPO_ACCESS_TOKEN}`}:{})},body:JSON.stringify({to:token,title:notice.title,body:notice.body,channelId:'tournament',data:{tournamentId:job.tournamentId,noticeId:notice.id,eventId:job.id}}),signal:AbortSignal.timeout(10000)});
    if(!response.ok) throw new Error('EXPO_UNAVAILABLE');
    const body=await response.json() as {data:ProviderReply};
    if(body.data?.details?.error==='DeviceNotRegistered') {
      await this.service.store.commit([{namespace:'devices',key:token,value:null},{namespace:'pushReceipts',key:receiptKey,value:{id:receiptKey,jobId:job.id,token,ticketId:'',createdAt:Date.now(),checkedAt:Date.now(),status:'failed',error:'DeviceNotRegistered'}}]);return;
    }
    if(body.data?.status!=='ok' || !body.data.id) throw new Error('EXPO_REJECTED');
    const receipt:DeliveryReceipt={id:receiptKey,jobId:job.id,token,ticketId:body.data.id,createdAt:Date.now(),checkedAt:null,status:'accepted'};
    await this.service.store.commit([{namespace:'pushReceipts',key:receiptKey,value:receipt}]);
  }
  private async checkReceipts() {
    const receipts=(await this.service.store.list<DeliveryReceipt>('pushReceipts')).filter(r=>r.status==='accepted' && Date.now()-r.createdAt>=15*60000).slice(0,100);
    if(!receipts.length) return;
    try {
      const response=await this.fetcher('https://exp.host/--/api/v2/push/getReceipts',{method:'POST',headers:{'Content-Type':'application/json',...(this.env.EXPO_ACCESS_TOKEN?{Authorization:`Bearer ${this.env.EXPO_ACCESS_TOKEN}`}:{})},body:JSON.stringify({ids:receipts.map(r=>r.ticketId)}),signal:AbortSignal.timeout(10000)});
      if(!response.ok) return;
      const body=await response.json() as {data:Record<string,ProviderReply>};
      for(const receipt of receipts) {
        const result=body.data?.[receipt.ticketId];
        if(!result && Date.now()-receipt.createdAt<24*3600000) continue;
        const error=result?.details?.error;
        await this.service.store.commit([{namespace:'pushReceipts',key:receipt.id,value:{...receipt,checkedAt:Date.now(),status:!result?'unknown':result.status==='ok'?'delivered':'failed',error:error??(!result?'RECEIPT_EXPIRED':undefined)}},...(error==='DeviceNotRegistered'?[{namespace:'devices',key:receipt.token,value:null}]:[])]);
      }
    } catch { /* Keep accepted tickets for the next durable polling pass. */ }
  }
  private async sendToss(job:PushJob,notice:StoredNotice,userKey:string) {
    const code=this.env[`MONGJIN_TOSS_TEMPLATE_${job.kind.toUpperCase()}`];
    if(!code || !this.env.TOSS_MTLS_CERT_PATH || !this.env.TOSS_MTLS_KEY_PATH) throw new Error('TOSS_UNCONFIGURED');
    const [cert,key]=await Promise.all([readFile(this.env.TOSS_MTLS_CERT_PATH),readFile(this.env.TOSS_MTLS_KEY_PATH)]);
    const body=JSON.stringify({templateSetCode:code,context:{tournamentId:job.tournamentId,title:notice.title}});
    await new Promise<void>((resolve,reject)=>{
      const req=this.tossRequester({hostname:'apps-in-toss-api.toss.im',path:'/api-partner/v1/apps-in-toss/messenger/send-message',method:'POST',cert,key,headers:{'Content-Type':'application/json','x-toss-user-key':userKey,'Content-Length':Buffer.byteLength(body)}},res=>{
        const chunks:Buffer[]=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>65536) req.destroy(new Error('RESPONSE_TOO_LARGE'));else chunks.push(chunk);});
        res.on('end',()=>{
          try {
            const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if(res.statusCode===200 && reply.resultType==='SUCCESS' && (reply.success?.sentPushCount>0 || reply.success?.sentInboxCount>0)) resolve();
            else reject(new Error('TOSS_REJECTED'));
          } catch {reject(new Error('TOSS_INVALID_REPLY'));}
        });
      });
      req.setTimeout(10000,()=>req.destroy(new Error('TOSS_TIMEOUT')));req.on('error',reject);req.end(body);
    });
  }
}
