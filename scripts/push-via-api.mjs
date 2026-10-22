/**
 * 用 GitHub REST API 推送整个提交（绕开 git push）。
 *
 * 为什么需要：本机到 github.com:443 的 TLS 握手被中间设备重置，
 * `git push` 走不通。但 api.github.com（Cloudflare）可用，
 * 所以改走 Git Data API：blobs → tree → commit → 更新 ref。
 *
 * 效果与 git push 等价：产生一个真实的 commit，历史连续。
 *
 * 关键经验（踩过的坑）：
 *   1. 一次性用 192 个条目建 tree 会 500。必须**分批**：每次带 30 条，
 *      用上一步返回的 tree.sha 作为下一次的 base_tree，逐层累加。
 *   2. base_tree 的好处是可以在已有树上"打补丁"，不用每次传全量。
 *   3. message 太长也可能触发 500，控制在 60KB 内。
 *
 * 用法：
 *   node scripts/push-via-api.mjs <token> <owner/repo> [branch|-] [msgFile] [--dry]
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const [, , tokenArg, repoArg, branchArg, msgFileArg] = process.argv;
if (!tokenArg || !repoArg) {
  console.error('用法: node scripts/push-via-api.mjs <token> <owner/repo> [branch] [msgFile]');
  process.exit(2);
}

const TOKEN = tokenArg;
const REPO = repoArg;
const BRANCH = branchArg && branchArg !== '-' ? branchArg : 'main';
const API = 'https://api.github.com';

/** 建 tree 时每批多少条。太大 GitHub 会 500，30 实测稳。 */
const TREE_BATCH = 30;

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'pcl3-push',
  'Content-Type': 'application/json',
};

async function gh(path, init = {}, timeoutMs = 120_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg = body && body.message ? body.message : text.slice(0, 300);
      const err = new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── 文件收集 ─────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SKIP_EXT = new Set(['.log', '.tsbuildinfo']);

function shouldSkip(relPath) {
  if (SKIP_FILES.has(relPath)) return true;
  if (SKIP_EXT.has(extname(relPath))) return true;
  if (relPath.startsWith('test/.cache')) return true;
  if (/^(data|instances|cache)\//.test(relPath)) return true;
  // 推送脚本自己的临时产物
  if (relPath.startsWith('_commit')) return true;
  return false;
}

function collect(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(base, abs).replace(/\\/g, '/');
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel)) continue;
      collect(abs, base, out);
      continue;
    }
    if (shouldSkip(rel)) continue;
    out.push({ abs, rel, size: st.size });
  }
  return out;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.zip', '.jar', '.exe']);

function isBinary(file, buf) {
  if (BINARY_EXT.has(extname(file.rel))) return true;
  for (let i = 0; i < Math.min(buf.length, 8000); i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function uploadBlob(file, attempt = 1) {
  const buf = readFileSync(file.abs);
  const payload = { content: buf.toString('base64'), encoding: 'base64' };
  try {
    return await gh(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (attempt >= 3) throw err;
    // 大文件偶尔超时，退避重试
    await sleep(1000 * attempt);
    return uploadBlob(file, attempt + 1);
  }
}

async function main() {
  const message = msgFileArg
    ? readFileSync(join(ROOT, msgFileArg), 'utf8').trim().slice(0, 60_000)
    : 'chore: sync';

  console.log(`仓库 ${REPO}，分支 ${BRANCH}`);
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const parentSha = ref.object.sha;
  console.log(`父提交 ${parentSha}`);

  const files = collect(ROOT);
  console.log(`待上传 ${files.length} 个文件`);

  // ── 1. 上传 blob ──
  const entries = new Array(files.length);
  let done = 0;
  let cursor = 0;
  const CONCURRENCY = 5;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      const file = files[index];
      const blob = await uploadBlob(file);
      entries[index] = { path: file.rel, mode: '100644', type: 'blob', sha: blob.sha };
      done += 1;
      if (done % 25 === 0 || done === files.length) {
        console.log(`  blob ${done}/${files.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ── 2. 分批建 tree ──
  // 关键：不能一次传 192 条（GitHub 会 500）。每次带 TREE_BATCH 条，
  // 用上一次返回的 sha 作为下一次的 base_tree，逐层累加。
  console.log('创建 tree（分批）…');
  let treeSha = parentSha;
  let batchIndex = 0;
  for (let i = 0; i < entries.length; i += TREE_BATCH) {
    const slice = entries.slice(i, i + TREE_BATCH);
    batchIndex += 1;
    let attempt = 1;
    for (;;) {
      try {
        const tree = await gh(
          `/repos/${REPO}/git/trees`,
          {
            method: 'POST',
            body: JSON.stringify({ base_tree: treeSha, tree: slice }),
          },
          180_000,
        );
        treeSha = tree.sha;
        console.log(`  批次 ${batchIndex}（${slice.length} 条）→ ${treeSha.slice(0, 8)}`);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        console.log(`  批次 ${batchIndex} 失败（${err.status ?? '?'}），重试 ${attempt}…`);
        await sleep(1500 * attempt);
        attempt += 1;
      }
    }
  }

  // ── 3. 建 commit ──
  console.log('创建 commit…');
  let commit;
  for (let attempt = 1; ; attempt += 1) {
    try {
      commit = await gh(`/repos/${REPO}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
      });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.log(`  commit 失败（${err.status ?? '?'}），重试 ${attempt}…`);
      await sleep(1500 * attempt);
    }
  }
  console.log(`  commit = ${commit.sha}`);

  // ── 4. 更新 ref ──
  console.log('更新分支…');
  await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  console.log(`\n✅ 推送完成`);
  console.log(`   commit : ${commit.sha}`);
  console.log(`   文件数 : ${files.length}`);
  console.log(`   查看   : https://github.com/${REPO}/commit/${commit.sha}`);
}

main().catch((err) => {
  console.error('\n❌ 失败：', err.message);
  process.exit(1);
});
