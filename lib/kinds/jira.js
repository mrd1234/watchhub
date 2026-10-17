// jira: issues new to a JQL's result, or whose `updated` moved. Needs instance jira.base and
// jira.email, and JIRA_API_TOKEN (or jira.tokenEnv) in the environment.
//   {"jira": {"jql": "project = ABC AND status != Closed", "fields": ["assignee"]}}
module.exports = {
  name: "jira",
  env: (w, cfg) => [cfg?.jira?.tokenEnv || "JIRA_API_TOKEN"],
  validate(w) { if (!w.jira || !w.jira.jql) throw new Error("jira needs jql"); },
  async poll(w, st, cfg, env, api) {
    if (!cfg.jira || !cfg.jira.base) throw new Error("instance.json needs jira.base and jira.email");
    const { issues = [] } = await api.jiraSearch(cfg, env, { jql: w.jira.jql, maxResults: 100, fields: ["summary", "status", "updated", ...(w.jira.fields || [])] });
    const now = Object.fromEntries(issues.map((i) => [i.key, i.fields.updated]));
    if (!st || !st.issues) return { events: [], state: { issues: now } }; // first run, or state of another shape: baseline only
    const events = issues.filter((i) => st.issues[i.key] !== i.fields.updated).slice(0, 10)
      .map((i) => `${st.issues[i.key] ? "changed" : "new"} ${i.key} ${i.fields.status?.name || ""} ${api.oneLine(i.fields.summary, 90)}`);
    return { events, state: { issues: now } };
  },
};
