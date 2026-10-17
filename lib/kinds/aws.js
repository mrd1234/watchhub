// aws: run an AWS CLI read with JSON output and inspect it by the change-detection rules. One
// aws.exe per poll; the CLI's own login state is used, nothing is passed in.
//   {"aws": {"args": ["codebuild", "batch-get-builds", "--ids", "proj:uuid"], "profile": "p", "region": "r"}, "items": "builds", "changed": "buildStatus", "text": "{id} {buildStatus}"}
module.exports = {
  name: "aws",
  validate(w) { if (!w.aws || !Array.isArray(w.aws.args) || !w.aws.args.length) throw new Error("aws needs args (an array)"); },
  async poll(w, st, cfg, env, api) {
    const a = w.aws;
    const args = [...a.args, ...(a.profile ? ["--profile", a.profile] : []), ...(a.region ? ["--region", a.region] : []), "--output", "json"];
    const payload = await api.runJson("aws", args, a.timeoutSec || 30);
    return api.detect(w, st, payload);
  },
};
