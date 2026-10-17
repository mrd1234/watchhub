# example instance

Copy what you need into your own instance folder (`watchhub init <folder>` puts a copy of this
folder inside it as `example/`).

- `instance.json`: every section the helper modules read, with placeholders. Only `probes`,
  `intervals`, `scopes`, `defaultScope`, `notifyWho`, `agentNotes`, `engine` and `webhook` are
  read by the engine itself; `repos`, `prAuthors`, `jira`, `board`, `aws`, `vpn` and `stamps` belong to the
  modules below, and `github`, `system`, `jenkins`, `sonar`, `deploys` and `slack` to the shipped
  ones (the reference's Shipped modules table), so leave out what you do not use.
- `modules/`: helpers written against the module contract. `pr-merges` and `pr-checks` (GitHub,
  conditional REST and one GraphQL per repo), `board` (Jira projects, quiet moves and comments
  filtered at source), `aws-auth` (SSO session per profile), `vpn` (which side of a split network
  answers), `stamps` (a version endpoint per environment, confirmed over two polls). Copy one and
  change the endpoints to make the same helper for another provider.
- `watches/`: generic watches that need no code. GitLab merge requests, Azure DevOps builds and
  Bitbucket pull requests through the `http` kind with a token from the environment; an API value
  (`value` path) that fires when it changes; a queue consumer as an `exec` stream; a `webhook` with
  a shared secret; `disk-free` and `cpu-high` carry a `metric` block for displays.
- `plans/release.json`: a plan with `do` instructions and a `quiet` rule.
- `metrics.json`: what the engine writes for those two metrics, the shape a display reads.

Tokens are never in these files. Put them in your user environment (on Windows, the scheduled
task reads the user's environment variables; a token exported only in one shell is invisible to
it) and run `watchhub doctor` to see what is set and reachable.
