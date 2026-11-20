import {boundedBytes} from '../security/http.mjs';
import {createHmac, timingSafeEqual} from 'node:crypto';

export const socketPath = '/api/account/realtime/socket';
export const ticketPath = '/api/account/realtime/ticket';
export const relayPath = '/internal/realtime';
const protocol = 'xerox-realtime-v1';
const adminChannel = 'admin';
const accountChannel = id => 'account:' + id;

function mac(secret, payload) {
 return createHmac('sha256', secret).update('xerox-realtime-v1:').update(payload).digest();
}

export function issueRealtimeTicket(request, env, user, sessionHash, admin) {
 if (!env.REALTIME || !env.API_SHARED_SECRET) return new Response(null, {status:503});
 if (user.traffic_stopped) return new Response(null, {status:423});
 const scope = new URL(request.url).searchParams.get('scope') === 'admin' ? 'admin' : 'account';
 if (scope === 'admin' && (!admin || user.banned || user.traffic_stopped)) return new Response(null, {status:403});
 const payload = Buffer.from(JSON.stringify({
  sessionHash, scope, origin:request.headers.get('Origin'), expires:Date.now()+30000,
 })).toString('base64url');
 const ticket = payload + '.' + mac(env.API_SHARED_SECRET, payload).toString('base64url');
 return Response.json({ticket}, {headers:{'Cache-Control':'private, no-store'}});
}

export async function upgradeRealtime(request, env, lookup, isMaster) {
 const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(p=>p.trim());
 const match = /^([A-Za-z0-9_-]{1,600})\.([A-Za-z0-9_-]{43})$/.exec(protocols[1] || '');
 if (!env.REALTIME || !env.API_SHARED_SECRET || request.method !== 'GET' ||
     request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
     protocols.length !== 2 || protocols[0] !== protocol || !match) return new Response(null, {status:403});
 const signature = Buffer.from(match[2], 'base64url');
 if (signature.length !== 32 || !timingSafeEqual(signature, mac(env.API_SHARED_SECRET, match[1]))) {
  return new Response(null, {status:403});
 }
 const ticket = JSON.parse(Buffer.from(match[1], 'base64url').toString());
 if (ticket.expires <= Date.now() || ticket.origin !== request.headers.get('Origin')) return new Response(null, {status:403});
 const user = await lookup(env.DB, env, ticket.sessionHash);
 if (!user || user.traffic_stopped) return new Response(null, {status:403});
 const admin = ticket.scope === 'admin';
 if (admin && (user.banned || !isMaster(user, env))) return new Response(null, {status:403});
 const channel = admin ? adminChannel : accountChannel(user.id);
 const headers = new Headers({
  Upgrade:'websocket',
  'X-Realtime-User':user.id,
  'X-Realtime-Session':ticket.sessionHash,
  'X-Realtime-Expires':String(user.expires_at),
  'X-Realtime-Banned':user.banned ? '1' : '0',
 });
 return env.REALTIME.getByName(channel).fetch('https://realtime.internal/connect', {headers});
}

const relayMac = (secret, body) => createHmac('sha256',secret).update('xerox-realtime-relay-v1:').update(body).digest();

export async function receiveRealtimeRelay(request, env) {
 if (request.method !== 'POST' || !env.REALTIME || !env.REALTIME_RELAY_SECRET) return new Response(null,{status:404});
 const supplied = Buffer.from(request.headers.get('X-Realtime-Signature') || '', 'hex');
 if (supplied.length !== 32) return new Response(null,{status:403});
 let body;
 try { body = new TextDecoder().decode(await boundedBytes(request,1024)); }
 catch { return new Response(null,{status:413}); }
 if (!timingSafeEqual(supplied,relayMac(env.REALTIME_RELAY_SECRET,body))) return new Response(null,{status:403});
 const {channel,event,userId,sessionHash,at} = JSON.parse(body);
 if (!Number.isSafeInteger(at) || Math.abs(Date.now()-at)>30000) return new Response(null,{status:403});
 if (channel!=='admin' && !/^account:[A-Za-z0-9_-]{1,64}$/.test(channel)) return new Response(null,{status:400});
 if (!['mode','banned','unbanned','session','dm','rooms','accounts','logs','monitor'].includes(event)) return new Response(null,{status:400});
 const target=env.REALTIME.getByName(channel);
 if(event==='monitor')await target.invalidateMonitor();
 await target.publish(event,userId,sessionHash);
 return new Response(null,{status:204});
}

export async function sendRelay(env, event) {
 const target = new URL(relayPath, env.REALTIME_RELAY_URL);
 if (target.protocol!=='https:' || !target.hostname.endsWith('.workers.dev') || !env.REALTIME_RELAY_SECRET) throw Error('Invalid realtime relay configuration');
 const body = JSON.stringify({...event,at:Date.now()});
 const response = await fetch(target,{method:'POST',body,redirect:'manual',
  headers:{'X-Realtime-Signature':relayMac(env.REALTIME_RELAY_SECRET,body).toString('hex')},
  signal:AbortSignal.timeout(3000),
 });
 if (!response.ok) throw Error('Realtime relay rejected notification');
 return response;
}

export async function readSystemMonitor(env) {
 if (env.REALTIME) return env.REALTIME.getByName(adminChannel).monitorEnabled();
 const row = await env.DB.prepare('SELECT enabled FROM system_monitor_settings WHERE id=1').first();
 return row?.enabled===1;
}

export async function updateSystemMonitor(env, enabled, updatedAt) {
 if (env.REALTIME) {
  await env.REALTIME.getByName(adminChannel).setMonitor(enabled,updatedAt);
 }
 await notifyAdmin(env,'monitor');
}

async function publish(env, channel, event, userId, sessionHash) {
 try {
  if (!env.REALTIME) return;
  const target=env.REALTIME.getByName(channel);
  await target.publish(event,userId,sessionHash);
  if(env.REALTIME_RELAY_URL)await target.enqueueRelay({channel,event,userId,sessionHash});
 } catch (error) {
  console.warn('realtime_delivery_failed', event, error?.name);
 }
}

export const notifyAdmin = (env, event) => publish(env, adminChannel, event);
export const notifyUsers = (env, ids, event) => Promise.all(
 [...new Set(ids)].map(id=>publish(env, accountChannel(id), event)),
);
export const revokeRealtime = (env, id, sessionHash) => Promise.all([
 publish(env, accountChannel(id), 'session', id, sessionHash),
 publish(env, adminChannel, 'session', id, sessionHash),
]);

export async function notifyRoom(env, roomId) {
 if (!env.REALTIME) return;
 try {
  const members = await env.DB.prepare("SELECT user_id FROM dm_members WHERE room_id=? AND status='joined'").bind(roomId).all();
  await notifyUsers(env, (members.results || []).map(row=>row.user_id), 'rooms');
 } catch (error) {
  console.warn('realtime_room_delivery_failed', error?.name);
 }
}

export async function notifyPublicRooms(env) {
 if (!env.REALTIME) return;
 try {
  const profiles = await env.DB.prepare('SELECT user_id FROM dm_profiles').all();
  await notifyUsers(env, (profiles.results || []).map(row=>row.user_id), 'rooms');
 } catch (error) {
  console.warn('realtime_public_room_delivery_failed', error?.name);
 }
}
