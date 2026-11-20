import {DurableObject} from 'cloudflare:workers';
import {sendRelay} from './realtime.mjs';
import {createD1Database} from '../../d1-rest.mjs';

// Hibernating sockets carry invalidations only. All private reads still go
// through the application's session, moderation and membership checks.
export class RealtimeChannel extends DurableObject {
 constructor(ctx, env) {
  super(ctx, env);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pending_notifications(type TEXT PRIMARY KEY, due INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS relay_queue(key TEXT PRIMARY KEY, id TEXT NOT NULL, payload TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL)');
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

 async scheduleAlarm(force=false) {
  const next=this.ctx.storage.sql.exec('SELECT MIN(due) AS due FROM (SELECT due FROM relay_queue UNION ALL SELECT due FROM pending_notifications)').one().due;
  if(next===null)return;
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

 publish(type, userId, sessionHash) {
  const now = Date.now();
  // High-volume admin events are coalesced with a trailing notification.
  if (type === 'logs' || type === 'accounts') {
   if (!this.ctx.getWebSockets().length) return;
   const due = this.ctx.storage.sql.exec('SELECT due FROM pending_notifications LIMIT 1').toArray()[0]?.due;
   this.ctx.storage.sql.exec('INSERT OR IGNORE INTO pending_notifications(type,due) VALUES(?,?)', type, due ?? now+2000);
   return this.scheduleAlarm();
  }
  this.send(type, sessionHash || userId);
 }

 send(type, tag) {
  const now = Date.now();
  for (const socket of this.ctx.getWebSockets(tag)) {
   try {
    if ((socket.deserializeAttachment()?.expires ?? 0) <= now) socket.close(4001, 'Expired');
    else {
     socket.send(JSON.stringify({type}));
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
  const pending = sql.exec('DELETE FROM pending_notifications WHERE due<=? RETURNING type',now).toArray();
  for (const {type} of pending) this.send(type);
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
