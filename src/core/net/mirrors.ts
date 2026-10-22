/**
 * 已知下载源的静态描述 —— 唯一常量表。
 *
 * 为什么单列一个文件：`mirror.ts`（download 模块）里有 `MIRRORABLE_HOSTS` 白名单，
 * `install/endpoints.ts` 里有官方 URL，两边一旦各写一份就会漂移。
 * 这里只描述「源的标识、基础 URL、测速点」，**不改动**上述任一文件。
 *
 * 测速点的铁律：所有源必须用**同一个文件**，否则比的是文件大小与 CDN 缓存，不是延迟。
 * 目前统一用 `mc/game/version_manifest_v2.json`（约 270 KB。
 * 只读首包不算数 —— 我们要的是"能不能顺畅把东西下下来"，所以校验 HTTP 状态 + 至少收到一个数据块）。
 */

/** 一个可选下载源 */
export interface MirrorDefinition {
  /** 源标识，出现在配置文件与界面上 */
  id: string;
  /** 展示名 */
  label: string;
  /** 基础 URL（不带结尾斜杠） */
  base: string;
  /** 测速 URL（所有源必须是同一份文件） */
  probeUrl: string;
  /** 说明：这个源镜像了什么、什么情况下值得用 */
  note: string;
}

/** 测速用的公共路径（所有源拼在 base 之后，保证可比） */
export const PROBE_PATH = '/mc/game/version_manifest_v2.json';

/**
 * 已知源列表（顺序 = 默认偏好顺序，也是「全部不可用时」的兜底顺序）。
 *
 * - `mojang`  ：官方 launchermeta。最权威，国际网络下通常最快。
 * - `piston`  ：官方 piston-meta CDN。内容与 mojang 一致，但走的是另一组 CDN 边缘节点，
 *               国内偶尔明显快于 launchermeta，所以单列一个源而不是合并。
 * - `bmclapi` ：BMCLAPI 国内镜像。大陆网络下通常最快；国际网络下反而慢。
 */
export const MIRROR_DEFINITIONS: readonly MirrorDefinition[] = [
  {
    id: 'mojang',
    label: 'Mojang 官方',
    base: 'https://launchermeta.mojang.com',
    probeUrl: `https://launchermeta.mojang.com${PROBE_PATH}`,
    note: '官方元数据源，最权威；国际网络下通常最快。',
  },
  {
    id: 'piston',
    label: 'Mojang Piston CDN',
    base: 'https://piston-meta.mojang.com',
    probeUrl: `https://piston-meta.mojang.com${PROBE_PATH}`,
    note: '官方另一组 CDN，内容与 Mojang 官方一致，有时更快。',
  },
  {
    id: 'bmclapi',
    label: 'BMCLAPI 镜像',
    base: 'https://bmclapi2.bangbang93.com',
    probeUrl: `https://bmclapi2.bangbang93.com${PROBE_PATH}`,
    note: '国内镜像，大陆网络下通常最快；海外访问可能反而慢。',
  },
];

/** 按 id 找源定义 */
export function findMirror(id: string): MirrorDefinition | undefined {
  const wanted = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return MIRROR_DEFINITIONS.find((m) => m.id === wanted);
}

/** 源 id → 展示名（未知 id 原样返回） */
export function mirrorLabel(id: string): string {
  return findMirror(id)?.label ?? id;
}

/**
 * 把「镜像前缀」列表按偏好排序（给 Downloader 的 `mirrors` 用）。
 *
 * 注意 Downloader 的语义是：**第 0 个候选永远是原始 URL**，镜像列表只是失败后的备选。
 * 所以这里返回的是「除了首选源之外，按测速结果排序的其余镜像前缀」。
 */
export function orderedMirrorBases(preferredId: string | undefined, order: readonly string[]): string[] {
  const chosen = typeof preferredId === 'string' ? preferredId.trim().toLowerCase() : '';
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string): void => {
    const def = findMirror(id);
    if (def === undefined || seen.has(def.id) || def.id === chosen) return;
    seen.add(def.id);
    out.push(def.base);
  };
  for (const id of order) push(id);
  for (const def of MIRROR_DEFINITIONS) push(def.id);
  return out;
}
