const columns = 'id,at,actor,target_id,target,action,before_value,after_value';

export async function recordAdminAction(env, actor, target, action, before = null, after = null) {
  try {
    await (env.MANAGEMENT_DB ?? env.DB).prepare(
      'INSERT INTO admin_action_history(at,actor,target_id,target,action,before_value,after_value) VALUES(?,?,?,?,?,?,?)'
    ).bind(Date.now(), actor.username, target?.id ?? null, target?.username ?? null, action,
      JSON.stringify(before), JSON.stringify(after)).run();
    return true;
  } catch (error) {
    console.warn('admin_action_history_write_failed', error.name);
    return false;
  }
}

export async function listAdminActions(env, before) {
  const result = await (env.MANAGEMENT_DB ?? env.DB).prepare(
    'SELECT '+columns+' FROM admin_action_history WHERE id<? ORDER BY id DESC LIMIT 51'
  ).bind(before).all();
  const rows = result.results ?? [];
  return {
    entries: rows.slice(0, 50).map(({before_value, after_value, ...row}) => ({
      ...row, before: JSON.parse(before_value), after: JSON.parse(after_value),
    })),
    nextBefore: rows.length > 50 ? rows[49].id : null,
  };
}

export async function recordModerationBan(env, actor, targetId, enabled) {
  const db = env.DB;
  const target = await db.prepare(
    'SELECT users.id,users.username,COALESCE(account_controls.banned,0) AS banned,account_master_grants.user_id AS master_grant FROM users LEFT JOIN account_controls ON account_controls.user_id=users.id LEFT JOIN account_master_grants ON account_master_grants.user_id=users.id WHERE users.id=?'
  ).bind(targetId).first();
  if (!target) return {error:'対象アカウントがありません。', status:404};
  if (target.username==='xerox0521' || (enabled && (target.master_grant || target.username===String(env.MASTER_USERNAME||'').trim().toLowerCase()))) {
    return {error:'保護対象のアカウントは変更できません。', status:403};
  }
  await db.prepare('INSERT INTO account_controls(user_id,banned,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET banned=excluded.banned,updated_at=excluded.updated_at')
    .bind(targetId,Number(enabled),Date.now()).run();
  return {ok:true,auditRecorded:await recordAdminAction(env,actor,target,'ban',target.banned===1,enabled)};
}
