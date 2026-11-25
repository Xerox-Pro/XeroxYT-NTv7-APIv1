import {notifyUsers,notifyAdmin} from '../api/realtime.mjs';
export const managementDb = env => env.MANAGEMENT_DB ?? env.DB;

export function mergeControls(user, controls) {
  return {...user,banned:controls?.banned??user.banned??0,traffic_stopped:controls?.traffic_stopped??user.traffic_stopped??0};
}

export async function readControls(env, user, includeMode = false) {
  if (!user||!env.MANAGEMENT_DB) return user;
  // Retrieve mode alongside the existing authoritative account-control lookup.
  const sql=includeMode
    ? 'SELECT c.banned,c.traffic_stopped,m.mode,m.monitoring FROM (SELECT ? AS user_id) u LEFT JOIN managed_account_controls c ON c.user_id=u.user_id LEFT JOIN account_management m ON m.user_id=u.user_id'
    : 'SELECT banned,traffic_stopped FROM managed_account_controls WHERE user_id=?';
  const controls=await managementDb(env).prepare(sql).bind(user.id).first();
  return {...mergeControls(user,controls),...(includeMode?{mode:controls?.mode??user.mode??'off',monitoring:controls?.monitoring===1}:{})};
}

export async function setControl(env, userId, action, enabled) {
  const column = action==='ban'?'banned':'traffic_stopped';
  if (!env.MANAGEMENT_DB) {
    await env.DB.prepare(`INSERT INTO account_controls(user_id,${column},updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`)
      .bind(userId,Number(enabled),Date.now()).run();
  } else await env.MANAGEMENT_DB.prepare(`INSERT INTO managed_account_controls(user_id,${column}) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET ${column}=excluded.${column}`)
    .bind(userId,Number(enabled)).run();
  await Promise.all([
    notifyUsers(env,[userId],action==='ban'?(enabled?'banned':'unbanned'):'session'),
    notifyAdmin(env,'accounts'),
  ]);
}
