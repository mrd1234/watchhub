// file: a local file's size or mtime changed, or with `match`, new appended lines that match
// (up to five per poll, read from where the last poll stopped; the first poll starts at the end).
//   {"file": {"path": "C:/temp/run.log", "match": "FAILED|Error:"}}
const fs = require("fs");

module.exports = {
  name: "file",
  validate(w) { if (!w.file || !w.file.path) throw new Error("file needs path"); },
  async poll(w, st, cfg, env, api) {
    const p = w.file.path, re = w.file.match || w.match;
    const s = fs.existsSync(p) ? fs.statSync(p) : { size: 0, mtimeMs: 0 };
    if (!re) {
      const now = { size: s.size, mtime: s.mtimeMs };
      if (!st) return { events: [], state: now };
      return { events: st.size !== now.size || st.mtime !== now.mtime ? [`changed: ${s.size} bytes`] : [], state: now };
    }
    let from = !st || st.offset > s.size ? s.size : st.offset;
    if (s.size === from) return { events: [], state: { offset: from } };
    if (s.size - from > 1 << 20) from = s.size - (1 << 20);   // a huge append is read from its last megabyte, not all at once
    const rx = new RegExp(re);
    const lines = api.readRange(p, from, s.size).split(/\r?\n/).filter((l) => rx.test(l));
    return { events: lines.slice(0, 5).map((l) => `line: ${api.oneLine(l, 200)}`), state: { offset: s.size } };
  },
};
