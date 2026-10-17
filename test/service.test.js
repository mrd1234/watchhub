const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const service = require("../lib/service");

// The Linux and macOS service definitions are checked as text here: a service manager is not around in CI.
test("systemd unit and launchd plist are well-formed and point at this engine and instance", () => {
  const inst = { dir: "/home/dev/watch \"quoted\" & co" };
  const unit = service.unitText(inst);
  assert.match(unit, /^\[Unit\]\n/);
  assert.match(unit, /ExecStart="[^"]+" "[^"]+watchhub\.js" engine --instance "\/home\/dev\/watch \\"quoted\\" & co"\n/);
  assert.match(unit, /Restart=always\nRestartSec=60/);
  assert.match(unit, /WantedBy=default\.target/);
  const plist = service.plistText(inst);
  assert.match(plist, /^<\?xml version="1\.0"/);
  assert.match(plist, /<key>Label<\/key><string>com\.watchhub\.watchhub-watch-quoted-co-[0-9a-f]{6}<\/string>/);
  assert.match(plist, /<string>engine<\/string><string>--instance<\/string><string>\/home\/dev\/watch "quoted" &amp; co<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.ok((plist.match(/<dict>/g) || []).length === (plist.match(/<\/dict>/g) || []).length);
  assert.equal(service.unitName(inst), service.taskName(inst).replace(/[^A-Za-z0-9._-]+/g, "-"));
  assert.ok(path.isAbsolute(process.execPath));
});

test("windows launcher: runs the engine for this instance with no window, again after a crash, stands by while another engine runs, and ends on exit 0", { skip: process.platform !== "win32" && "wscript is Windows only" }, () => {
  const fs = require("fs"), os = require("os"), { spawnSync } = require("child_process");
  const text = service.launcherText({ dir: "C:\\x y\\watch" });
  assert.ok(text.includes(JSON.stringify(`"${process.execPath}" "${path.join(__dirname, "..", "bin", "watchhub.js")}" engine --instance "C:\\x y\\watch"`)));
  assert.ok(text.includes(JSON.stringify(path.join("C:\\x y\\watch", "engine.log"))));
  assert.match(text, /sh\.Run\(cmd, 0, true\)/);   // window 0 (hidden), wait for the engine
  // a stand-in engine that crashes twice, finds another engine running twice (3), crashes again, then stops cleanly
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchhub-launch-")), f = path.join(dir, "l.js"), fake = path.join(dir, "engine.js"), count = path.join(dir, "count"), log = path.join(dir, "engine.log");
  fs.writeFileSync(fake, 'const fs = require("fs"), f = process.argv[2], n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1; fs.writeFileSync(f, String(n)); process.exit([1, 1, 3, 3, 1, 0][n - 1]);\n');
  const cmd = `"${process.execPath}" "${fake}" "${count}"`;
  fs.writeFileSync(f, text.replace(/^var cmd = .*$/m, `var cmd = ${JSON.stringify(cmd)}, log = ${JSON.stringify(log)};`).replace(/\b5000\b/g, "50").replace(/\b60000\b/, "50"));
  assert.equal(spawnSync("wscript.exe", ["//B", "//Nologo", "//E:jscript", f], { timeout: 30000 }).status, 0);
  assert.equal(fs.readFileSync(count, "utf8"), "6");
  const lines = fs.readFileSync(log, "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ launcher: engine exited with code 1; running it again in 0\.05 s$/);
  assert.match(lines[1], /code 1; running it again in 0\.1 s$/);   // the pause doubles
  assert.match(lines[2], /launcher: another engine runs this instance; standing by, trying every minute$/);   // said once for two
  assert.match(lines[3], /code 1; running it again in 0\.05 s$/);   // standing by resets the pause
  const wide = service.launcherText({ dir: "C:\\Zoë\\watch" });
  assert.ok(/^[\x00-\x7f]*$/.test(wide) && wide.includes("Zo\\u00eb"), "past ASCII is escaped, as wscript reads the file in the ANSI code page");
});
