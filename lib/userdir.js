// The per-user folder: ~/.watchhub (or WATCHHUB_HOME). One place for what a person sets up once:
//   env           KEY=value lines (tokens, secrets); loaded into process.env for keys not already set,
//                 so a real environment variable still wins and nothing is ever written back
//   config.json   {"instance": "<folder>"} the default instance, so `watchhub` works from any directory
// The engine reads it at start too, which is how a scheduled task sees the tokens without them
// being user environment variables. Keep the folder private to the user (it is, by default, under
// a Windows profile and a 700 home on Unix).
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = () => process.env.WATCHHUB_HOME || path.join(os.homedir(), ".watchhub");
const envFile = () => path.join(dir(), "env");
const configFile = () => path.join(dir(), "config.json");

// KEY=value, KEY="quoted value", # comments, blank lines; `export KEY=value` tolerated.
function parseEnv(text) {
  const out = {};
  for (const raw of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {   // Notepad saves a BOM; it must not hide the first key
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Returns the names that came from the file (for doctor), or [] when there is no file.
const loadedKeys = new Set();
function loadEnv(env = process.env) {
  let text;
  try { text = fs.readFileSync(envFile(), "utf8"); } catch { return []; }
  const loaded = [];
  for (const [k, v] of Object.entries(parseEnv(text))) if (env[k] === undefined) { env[k] = v; loaded.push(k); }
  if (env === process.env) for (const k of loaded) loadedKeys.add(k);   // remembered: a later call finds them set and would call them "environment"
  return loaded;
}

function config() { try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return {}; } }

// Create the folder with a commented env template and, when given, the default instance.
function init(instanceDir) {
  fs.mkdirSync(dir(), { recursive: true });
  if (!fs.existsSync(envFile())) fs.writeFileSync(envFile(), [
    "# watchhub tokens, one KEY=value per line. A real environment variable with the same name wins.",
    "# GITHUB_TOKEN=ghp_...            (or leave unset and sign in with: gh auth login)",
    "# JIRA_API_TOKEN=...",
    "# GITLAB_TOKEN=...",
    "# Any ${NAME} a watch references goes here too.",
    "",
  ].join("\n"));
  if (instanceDir) fs.writeFileSync(configFile(), JSON.stringify({ ...config(), instance: instanceDir }, null, 2) + "\n");
}

module.exports = { dir, envFile, configFile, parseEnv, loadEnv, loadedKeys, config, init };
