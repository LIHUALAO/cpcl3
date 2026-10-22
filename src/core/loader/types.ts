/**
 * loader 模块的公开类型。
 *
 * 共享类型（VersionJson / Library / DownloadTask …）一律从 `../types.js` import，
 * 这里只放本模块独有的东西。
 */

export type LoaderKind = 'fabric' | 'quilt';

/** 契约要求的最小形状 */
export interface LoaderVersion {
  version: string;
  stable: boolean;
}

/**
 * LoaderVersion 的扩展描述（`listVersions` 返回的真身，契约字段一个不少）。
 *
 * 为什么要 trust 字段：
 *   - Fabric 的 `stable` 来自 meta 的 `loader.stable`，可信。
 *   - Quilt 的全局 loader 列表**没有 stable 字段**，只能按版本号里的
 *     `alpha` / `beta` / `pre` / `rc` 推断，属于启发式。
 *   - Fabric / Quilt 的「按游戏版本查询」接口实测都不按游戏版本过滤
 *     （Fabric 返回全量 255 条、Quilt 返回全量 307 条但换了嵌套形状），
 *     因此列表的「适用性」不可信，只能靠 profile 端点兜底。
 */
export interface LoaderVersionInfo extends LoaderVersion {
  /** 展示用版本号（等于 version） */
  version: string;
  /** meta 里是否显式声明 stable */
  stable: boolean;
  /** stable 的判断依据：显式声明 / 版本号启发式 / 未知 */
  stabilitySource: 'declared' | 'inferred' | 'unknown';
  /** 是否预发布（alpha/beta/pre/rc/snapshot） */
  prerelease: boolean;
  /** meta 给的 Maven 坐标（可能没有） */
  maven?: string;
  /** 该 loader 版本是否真的为这个游戏版本产出过 profile（listVersions 里无法确定时 undefined） */
  applicable?: boolean;
}

/** 进度回调（契约签名） */
export interface LoaderProgress {
  phase: string;
  done: number;
  total: number;
}

/** 下载计划里的单条任务（DownloadTask 的超集，带来源说明便于排错） */
export interface LoaderDownloadTask {
  url: string;
  dest: string;
  sha1?: string;
  size?: number;
  /** 该条目来自哪条 Maven 坐标 */
  library: string;
  /** 校验信息来源：artifact = 官方 downloads.artifact；library-sha1 = 平铺 sha1；none = 无校验信息 */
  integrity: 'artifact' | 'library-sha1' | 'none';
}

/** 安装计划（只算不下载） */
export interface LoaderInstallPlan {
  versionId: string;
  kind: LoaderKind;
  gameVersion: string;
  loaderVersion: string;
  tasks: LoaderDownloadTask[];
  /** 无校验信息的任务数量（这些只能裸下载） */
  unverified: number;
  totalBytes: number;
  /** 版本 JSON 落盘路径：<dataRoot>/versions/<versionId>/<versionId>.json */
  versionJsonPath: string;
}
