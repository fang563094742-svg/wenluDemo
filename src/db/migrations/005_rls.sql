-- 005 行级安全（RLS）：对大脑相关个人数据表强制按 user_id 隔离（Requirement 7.6）
-- 机制：连接侧经 withUser() 设置 app.current_user_id；策略只放行 user_id 匹配的行，
-- 缺会话变量时 current_setting(...,true) 返回 NULL → 比较为 NULL → 不放行（fail-closed）。
--
-- 注意（ADR-3）：超级用户/表 owner 默认 BYPASS RLS。开发期用 postgres 账号时本策略为 no-op，
-- 不影响现有流程；生产须用非超级、非 BYPASSRLS 的应用角色连库，策略方才强制生效。

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY['brain', 'memory', 'sensor_state', 'conversation_message', 'prediction_proj', 'verifiable_task_proj'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- 幂等：先删同名策略再建。
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (user_id = current_setting(''app.current_user_id'', true)::uuid) WITH CHECK (user_id = current_setting(''app.current_user_id'', true)::uuid)',
      t || '_isolation', t
    );
  END LOOP;
END $$;
