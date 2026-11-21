import {DurableObject} from 'cloudflare:workers';
import {sendRelay} from './realtime.mjs';
import {createD1Database} from '../../d1-rest.mjs';

const LOG_RETENTION_MS=10*60*1000;
const LOG_CLEANUP_INTERVAL_MS=60*1000;

// Hibernating sockets carry invalidations only. All private reads still go
// through the application's session, moderation and membership checks.
export class RealtimeChannel extends DurableObject {
 constructor(ctx, env) {
  super(ctx, env);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pending_notifications(type TEXT PRIMARY KEY, due INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS relay_queue(key TEXT PRIMARY KEY, id TEXT NOT NULL, payload TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS system_logs(id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL, pending INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS system_logs_at ON system_logs(at)');
  ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS system_logs_pending ON system_logs(at) WHERE pending=1');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS live_logs(id TEXT PRIMARY KEY)');
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
 }

 invalidateMonitor() {
  return this.ctx.storage.delete('monitor');
 }

 async enqueueRelay(payload) {
  const key = JSON.stringify([payload.event,payload.userId,payload.sessionHash]);
  this.ctx.storage.sql.exec(
   'INSERT INTO relay_queue VALUES(?,?,?,?,0) ON CONFLICT(key) DO UPDATE SET id=excluded.id,payload=excluded.payload',
   key,crypto.randomUUID(),JSON.stringify(payload),Date.now()+250,
  );
  await this.scheduleAlarm();
 }

 async storeLogs(logs,local) {
  const now=Date.now();
  const cutoff=now-LOG_RETENTION_MS;
  const sql=this.ctx.storage.sql;
  const live=this.ctx.getWebSockets().length>0;
  const pending=Number(local&&!!this.env.REALTIME_RELAY_URL);
  const inserted=this.ctx.storage.transactionSync(()=>{
   let changed=false;
   for(const row of logs){
    if(row.at<=cutoff)continue;
    const added=sql.exec('INSERT OR IGNORE INTO system_logs VALUES(?,?,?,?)',row.id,row.at,JSON.stringify(row),pending).rowsWritten;
    if(added&&live)sql.exec('INSERT OR IGNORE INTO live_logs VALUES(?)',row.id);
    changed ||= added>0;
   }
   if(changed&&(live||pending))sql.exec('INSERT OR IGNORE INTO pending_notifications VALUES(?,?)','log-stream',now+2000);
   return changed;
  });
  if(inserted)await this.scheduleAlarm();
 }

 async listLogs(userId,errorsOnly) {
  await this.scheduleAlarm();
  return this.ctx.storage.sql.exec(
   `SELECT data FROM system_logs WHERE at>? AND (?='' OR json_extract(data,'$.user_id')=?) AND (?=0 OR json_extract(data,'$.status')>=400) ORDER BY at DESC,id DESC LIMIT 150`,
   Date.now()-LOG_RETENTION_MS,userId,userId,Number(errorsOnly),
  ).toArray().reverse().map(({data})=>JSON.parse(data));
 }

 async flushLogStream() {
  const sql=this.ctx.storage.sql;
  const cutoff=Date.now()-LOG_RETENTION_MS;
  const live=sql.exec('SELECT system_logs.data FROM live_logs JOIN system_logs USING(id) WHERE at>? ORDER BY at DESC,id DESC LIMIT 200',cutoff).toArray();
  sql.exec('DELETE FROM live_logs');
  if(live.length)this.send('log-stream',undefined,{logs:live.reverse().map(({data})=>JSON.parse(data))});
  const retry=await this.ctx.storage.get('log-retry');
  const now=Date.now();
  if(retry?.due>now){
   sql.exec('INSERT OR IGNORE INTO pending_notifications VALUES(?,?)','log-stream',retry.due);
   return;
  }
  const rows=sql.exec('SELECT id,data FROM system_logs WHERE pending=1 AND at>? ORDER BY at,id LIMIT 50',cutoff).toArray();
  if(!rows.length)return;
  let next=now+2000;
  try {
   await sendRelay(this.env,{channel:'admin',event:'log-batch',logs:rows.map(({data})=>JSON.parse(data))});
   for(const {id} of rows)sql.exec('UPDATE system_logs SET pending=0 WHERE id=?',id);
   if(retry)await this.ctx.storage.delete('log-retry');
  }catch{
   const attempts=(retry?.attempts??0)+1;
   next=now+Math.min(300000,2000*2**Math.min(attempts,8));
   await this.ctx.storage.put('log-retry',{due:next,attempts});
  }
  if(sql.exec('SELECT 1 FROM system_logs WHERE pending=1 AND at>? LIMIT 1',cutoff).toArray().length){
   sql.exec('INSERT OR IGNORE INTO pending_notifications VALUES(?,?)','log-stream',next);
  }
 }

 async scheduleAlarm(force=false) {
  const sql=this.ctx.storage.sql;
  const nextEvent=sql.exec('SELECT MIN(due) AS due FROM (SELECT due FROM relay_queue UNION ALL SELECT due FROM pending_notifications)').one().due;
  const oldest=sql.exec('SELECT MIN(at) AS at FROM system_logs').one().at;
  // Batch expiry into minute boundaries to avoid one alarm per logged request.
  const expiry=oldest===null?Infinity:Math.ceil((oldest+LOG_RETENTION_MS)/LOG_CLEANUP_INTERVAL_MS)*LOG_CLEANUP_INTERVAL_MS;
  const next=Math.min(nextEvent??Infinity,Math.max(Date.now(),expiry));
  if(!Number.isFinite(next))return;
  const current=force?null:await this.ctx.storage.getAlarm();
  if(current===null||next<current)await this.ctx.storage.setAlarm(next);
 }

 async monitorEnabled() {
  const stored = await this.ctx.storage.get('monitor');
  if (stored && Date.now()-stored.checkedAt<300000) return stored.enabled;
  const db = this.env.DB ?? createD1Database(this.env);
  const row = await db.prepare('SELECT enabled,updated_at FROM system_monitor_settings WHERE id=1').first();
  return this.setMonitor(row?.enabled===1, row?.updated_at??0);
 }

 async setMonitor(enabled, updatedAt) {
  const state = await this.ctx.storage.transaction(async storage=>{
   const existing = await storage.get('monitor');
   if (existing && existing.updatedAt>updatedAt) return existing;
   const next = {enabled,updatedAt,checkedAt:Date.now()};
   await storage.put('monitor',next);
   return next;
  });
  return state.enabled;
 }

 fetch(request) {
  const userId = request.headers.get('X-Realtime-User');
  const sessionHash = request.headers.get('X-Realtime-Session');
  const expires = Number(request.headers.get('X-Realtime-Expires'));
  if (!userId || !sessionHash || expires <= Date.now()) return new Response(null, {status:403});
  const [client, server] = Object.values(new WebSocketPair());
  this.ctx.acceptWebSocket(server, [userId, sessionHash]);
  server.serializeAttachment({expires});
  server.send(JSON.stringify({type:'ready', banned:request.headers.get('X-Realtime-Banned') === '1', expires}));
  return new Response(null, {status:101, webSocket:client, headers:{'Sec-WebSocket-Protocol':'xerox-realtime-v1'}});
 }

 publish(type, userId, sessionHash, payload) {
  const now = Date.now();
  // High-volume admin events are coalesced with a trailing notification.
  if (type === 'logs' || type === 'accounts') {
   if (!this.ctx.getWebSockets().length) return;
   const due = this.ctx.storage.sql.exec('SELECT due FROM pending_notifications LIMIT 1').toArray()[0]?.due;
   this.ctx.storage.sql.exec('INSERT OR IGNORE INTO pending_notifications(type,due) VALUES(?,?)', type, due ?? now+2000);
   return this.scheduleAlarm();
  }
  this.send(type, sessionHash || userId,payload);
 }

 send(type, tag, payload) {
  const now = Date.now();
  for (const socket of this.ctx.getWebSockets(tag)) {
   try {
    if ((socket.deserializeAttachment()?.expires ?? 0) <= now) socket.close(4001, 'Expired');
    else {
     socket.send(JSON.stringify({type,...payload}));
     if (type === 'session') socket.close(4001, 'Session changed');
    }
   } catch {
    // An individual socket can close during a broadcast.
   }
  }
 }

 async alarm() {
  const sql=this.ctx.storage.sql;
  const now=Date.now();
  const cutoff=now-LOG_RETENTION_MS;
  this.ctx.storage.transactionSync(()=>{
   sql.exec('DELETE FROM live_logs WHERE id IN (SELECT id FROM system_logs WHERE at<=?)',cutoff);
   sql.exec('DELETE FROM system_logs WHERE at<=?',cutoff);
  });
  const pending = sql.exec('DELETE FROM pending_notifications WHERE due<=? RETURNING type',now).toArray();
  for (const {type} of pending) {
   if(type==='log-stream')await this.flushLogStream();
   else this.send(type);
  }
  const queue=sql.exec('SELECT * FROM relay_queue WHERE due<=? ORDER BY due LIMIT 10',now).toArray();
  await Promise.all(queue.map(async ({id,payload,attempts})=>{
   try {
    await sendRelay(this.env,JSON.parse(payload));
    sql.exec('DELETE FROM relay_queue WHERE id=?',id);
   } catch (error) {
    if(attempts===0)console.warn('realtime_relay_retry',error?.name);
    const delay=Math.min(300000,1000*2**Math.min(attempts,9));
    sql.exec('UPDATE relay_queue SET due=?,attempts=attempts+1 WHERE id=?',Date.now()+delay,id);
   }
  }));
  await this.scheduleAlarm(true);
 }

 webSocketMessage() {}
 webSocketClose(socket, code, reason) { socket.close(code, reason); }
}
