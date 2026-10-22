/**
 * Fabric / Quilt 的 meta 端点与常量。
 *
 * 两家 meta 服务都不在 download 模块的镜像白名单里
 * （MIRRORABLE_HOSTS 只覆盖 Mojang 官方域），所以这里直连，不做镜像改写；
 * Downloader 的 `whitelist` 策略会对非白名单 URL 原样放行，正好符合预期。
 */

import type { LoaderKind } from './types.js';

/** Fabric meta 根（v2） */
export const FABRIC_META_ROOT = 'https://meta.fabricmc.net';

/** Quilt meta 根（v3） */
export const QUILT_META_ROOT = 'https://meta.quiltmc.org';

/** 各 kind 的 meta 根 */
export const META_ROOTS: Record<LoaderKind, string> = {
  fabric: FABRIC_META_ROOT,
  quilt: QUILT_META_ROOT,
};

/** 各 kind 的 meta API 版本段 */
export const META_VERSION_SEGMENT: Record<LoaderKind, 'v2' | 'v3'> = {
  fabric: 'v2',
  quilt: 'v3',
};

/**
 * Maven 仓库根 —— profile 里 `libraries[].url` 缺失时的兜底。
 * 正常 profile 每条库都带 url，这里只是防御。
 */
export const DEFAULT_MAVEN_ROOT: Record<LoaderKind, string> = {
  fabric: 'https://maven.fabricmc.net/',
  quilt: 'https://maven.quiltmc.org/repository/release/',
};

/** 单次 meta 请求超时（毫秒） */
export const META_TIMEOUT_MS = 20_000;

/** 单次 meta 请求重试次数（不含首次） */
export const META_RETRIES = 2;

/** 默认 User-Agent（部分 CDN 按 UA 做策略） */
export const USER_AGENT = 'PCL3/0.1 (+https://github.com/pcl3)';

/** 版本 id 前缀（用于人话报错与识别） */
export const LOADER_LABEL: Record<LoaderKind, string> = {
  fabric: 'Fabric',
  quilt: 'Quilt',
};
