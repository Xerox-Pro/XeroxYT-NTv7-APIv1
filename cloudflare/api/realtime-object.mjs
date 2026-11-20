import {DurableObject} from 'cloudflare:workers';
import {createD1Database} from '../../d1-rest.mjs';

// Hibernating sockets carry invalidations only. All private reads still go
// through the application's session, moderation and membership checks.
export class RealtimeChannel extends DurableObject {
 constructor(ctx, env) {
  super(ctx, env);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pending_notifications(type TEXT PRIMARY KEY, due INTEGER NOT NULL)');
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
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
   if (!due) return this.ctx.storage.setAlarm(now+2000);
   return;
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

 alarm() {
  const pending = this.ctx.storage.sql.exec('DELETE FROM pending_notifications RETURNING type').toArray();
  for (const {type} of pending) this.send(type);
 }

 webSocketMessage() {}
 webSocketClose(socket, code, reason) { socket.close(code, reason); }
}
