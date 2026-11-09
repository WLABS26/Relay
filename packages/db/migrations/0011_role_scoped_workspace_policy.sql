-- 0011 Role-scoped workspace visibility.
--
-- Policy expressions run with the querying role's privileges. The membership-based read
-- policy on workspaces references workspace_memberships, which the worker role must not be
-- able to read. Split it: the web role may also see workspaces it is a member of (workspace
-- switcher, slug resolution); the worker only ever sees the workspace of its task context.

DROP POLICY workspaces_read ON workspaces;

CREATE POLICY workspaces_read_app ON workspaces FOR SELECT TO relay_app USING (
  id = (SELECT relay_current_workspace_id())
  OR EXISTS (
    SELECT 1 FROM workspace_memberships m
    WHERE m.workspace_id = workspaces.id AND m.user_id = (SELECT relay_current_user_id())
  )
);

CREATE POLICY workspaces_read_worker ON workspaces FOR SELECT TO relay_worker
  USING (id = (SELECT relay_current_workspace_id()));
