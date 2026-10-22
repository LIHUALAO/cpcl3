/**
 * 镜像前缀回退 —— BMCLAPI 约定：
 *
 *   https://bmclapi2.bangbang93.com + /libraries/com/mojang/xxx.jar
 *     ↦ https://libraries.minecraft.net/com/mojang/xxx.jar
 *
 * 也就是说镜像是个**前缀**，拼在「原 URL 的 path 部分」前面，替换掉原 scheme+host。
 * 绝对不能简单地 `mirror + 原URL`（那会得到 https://bmclapi/.../https://libraries.minecraft.net/... 这种畸形地址）。
 *
 * 只对「同源资源」做替换：BMCLAPI 只镜像了 Minecraft 官方那几个域，
 * 把任意第三方 URL 前缀拼一遍毫无意义还制造垃圾请求。所以这里做白名单域匹配。
 */

import { URL } from 'node:url';

/** 允许套镜像的官方源域（同源判定表）。 */
export const MIRRORABLE_HOSTS: readonly string[] = [
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'piston-data.mojang.com',
  'piston-meta.mojang.com',
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'api.minecraftservices.com',
  'session.minecraft.net',
  'textures.minecraft.net',
];

/** 判断某个 host 是否在镜像可覆盖范围内。 */
export function isMirrorable(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();

  // 精确匹配白名单；子域也认（CDN 会轮换 ab.cdn-libs.minecraft.net 这类名字）。
  // 注意必须按「标签边界」比较：libraries.minecraft.invalid 不属于 minecraft.net。
  return MIRRORABLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** 镜像目录归属：Mojang 的 CDN 是扁平命名空间，BMCLAPI 统一收在 /assets 下。 */
function mirrorPathPrefix(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized === 'resources.download.minecraft.net' || normalized === 'textures.minecraft.net') {
    return '/assets';
  }
  return '';
}

export type MirrorPolicy = 'whitelist' | 'always' | 'never';

/**
 * 生成候选 URL 列表：第 0 个永远是原始 URL，
 * 后面依次是各镜像拼出来的地址。
 *
 * policy（默认 `whitelist`）：
 *   - `whitelist`：只对白名单里的官方源套镜像。生产默认，也是安全的那一档。
 *   - `always`：对任意 http(s) URL 都套 —— 自建镜像/内网代理/测试环境用。
 *   - `never`：不套镜像，只返回原 URL。
 *
 * 不做去重以外的任何 URL 改写；`?query` 原样保留。
 */
export function buildCandidates(
  rawUrl: string,
  mirrors: readonly string[],
  policy: MirrorPolicy = 'whitelist',
): string[] {
  const out: string[] = [rawUrl];
  if (policy === 'never' || mirrors.length === 0) return out;
  if (policy === 'whitelist' && !isMirrorable(rawUrl)) return out;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return out;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return out;

  const subPath = mirrorPathPrefix(parsed.hostname.toLowerCase());

  for (const mirror of mirrors) {
    if (typeof mirror !== 'string' || mirror.trim() === '') continue;
    const base = mirror.trim().replace(/\/+$/, '');
    const candidate = `${base}${subPath}${parsed.pathname}${parsed.search}`;
    if (!out.includes(candidate)) out.push(candidate);
  }

  return out;
}

/** 单次失败（供 `fallbackMirrorFromUrl` 用）：只描述「哪个失败、为什么」 */
export interface CandidateFailure {
  /** 失败时实际尝试的候选 URL（可能是镜像地址，也可能是原始地址） */
  url: string;
  /** 上一次尝试遇到的错误（缺省表示"试过了但没拿到错误对象"） */
  error?: Error;
}

/**
 * 从「失败的候选 URL」反推「该换哪个源」—— 只读辅助函数，不改动任何既有行为。
 *
 * 存在的理由：Downloader 想把「连续 N 次失败」上报给选源器（net 模块的
 * `MirrorSelector.reportFailure`），但它手里只有候选 URL，不知道那串 URL 对应
 * 哪一个镜像前缀。这里把反推逻辑放在 mirror.ts（镜像语义的唯一归属地），
 * Downloader 只负责计数与回调，两边都不必知道对方的内部结构。
 *
 * 判定顺序：
 *   1. 与原始 URL 完全一致 → `null`：失败来自**官方源本身**，不是镜像的问题，
 *      不该拿它去降级任何镜像。
 *   2. 命中某个镜像前缀 → 返回那个镜像的 base。
 *   3. 都不匹配 → `null`（例如 policy='always' 套的自建镜像、或 URL 已变形）。
 *
 * 注意：这里比较的是「字符串前缀」，与 `buildCandidates` 的拼接方式完全对称
 * （`base + subPath + pathname + search`），所以不会出现误判。
 */
export function fallbackMirrorFromUrl(
  failure: CandidateFailure,
  rawUrl: string,
  mirrors: readonly string[],
): string | null {
  const failed = typeof failure.url === 'string' ? failure.url.trim() : '';
  if (failed === '' || failed === rawUrl) return null;

  let best: string | null = null;
  for (const mirror of mirrors) {
    if (typeof mirror !== 'string' || mirror.trim() === '') continue;
    const base = mirror.trim().replace(/\/+$/, '');
    // 取最长匹配：万一以后有 mirrors 里一个是另一个的前缀，也不会认错源
    if (failed.startsWith(base) && (best === null || base.length > best.length)) best = base;
  }
  return best;
}
