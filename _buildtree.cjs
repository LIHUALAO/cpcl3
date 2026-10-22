const fs = require("node:fs"), path = require("node:path");
const ROOT = "C:\\Users\\Administrator\\Desktop\\DSW\\PCL3";
const TOKEN = process.env.PCL3_PAT;
const API = "https://api.github.com/repos/LIHUALAO/cpcl3";
const h = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "pcl3", "Content-Type": "application/json" };
const SKIP_DIRS = new Set(["node_modules","dist",".git"]);
const SKIP_EXT = new Set([".log",".tsbuildinfo"]);
function collect(dir, base=dir, out=[]) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir,name), rel = path.relative(base,abs).replace(/\\/g,"/");
    const st = fs.statSync(abs);
    if (st.isDirectory()) { if (SKIP_DIRS.has(name) || rel.startsWith("test/.cache")) continue; collect(abs,base,out); continue; }
    if (SKIP_EXT.has(path.extname(rel)) || rel.startsWith("_commit") || rel.startsWith("test/.cache")) continue;
    if (/^(data|instances|cache)\//.test(rel)) continue;
    out.push({abs,rel});
  }
  return out;
}
async function gh(p, init={}) {
  const r = await fetch(API+p, {...init, headers: h});
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : undefined } catch { b = t }
  if (!r.ok) { const e = new Error(`${init.method??"GET"} ${p} → ${r.status}: ${b?.message??t.slice(0,200)}`); e.status = r.status; throw e; }
  return b;
}
(async () => {
  const files = collect(ROOT);
  console.log("文件:", files.length);
  const entries = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    const blob = await gh("/git/blobs", {method:"POST", body: JSON.stringify({content: buf.toString("base64"), encoding:"base64"})});
    entries.push({path: f.rel, mode:"100644", type:"blob", sha: blob.sha});
  }
  console.log("blob 上传完成");
  const ref = await gh("/git/ref/heads/main");
  let treeSha = ref.object.sha;
  for (let i = 0; i < entries.length; i += 30) {
    const slice = entries.slice(i, i+30);
    const t = await gh("/git/trees", {method:"POST", body: JSON.stringify({base_tree: treeSha, tree: slice})});
    treeSha = t.sha;
    console.log("  批次", Math.floor(i/30)+1, "→", treeSha);
  }
  console.log("FINAL_TREE=" + treeSha);
  fs.writeFileSync(path.join(ROOT, "_tree-sha.txt"), treeSha, "utf8");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });