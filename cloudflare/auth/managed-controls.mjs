export const managementDb = env => env.MANAGEMENT_DB ?? env.DB;

export function mergeControls(user, controls) {
  return {...user,banned:controls?.banned??user.banned??0,traffic_stopped:controls?.traffic_stopped??user.traffic_stopped??0};
}

export async function readControls(env, user) {
  if (!user||!env.MANAGEMENT_DB) return user;
  const controls = await managementDb(env).prepare('SELECT banned,traffic_stopped FROM managed_account_controls WHERE user_id=?').bind(user.id).first();
  return mergeControls(user,controls);
}

export async function setControl(env, userId, action, enabled) {
  const column = action==='ban'?'banned':'traffic_stopped';
  if (!env.MANAGEMENT_DB) {
    await env.DB.prepare(`INSERT INTO account_controls(user_id,${column},updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`)
      .bind(userId,Number(enabled),Date.now()).run();
    return;
  }
  await env.MANAGEMENT_DB.prepare(`INSERT INTO managed_account_controls(user_id,${column}) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET ${column}=excluded.${column}`)
    .bind(userId,Number(enabled)).run();
}
