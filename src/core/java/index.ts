/**
 * java 模块统一出口：Minecraft 官方 Java 运行时的自动下载与落盘。
 *
 * 契约入口只有 `JavaRuntimeInstaller` 与两个类型（`JavaRuntimeManifest` / `JavaComponent`）。
 * 其余导出是「可复用零件 + 测试注入点」，不属于契约约束面：
 *   - `platform.ts`  → 平台 key 判定、主版本推导（要求里的「平台判定要能测试」由此支持）
 *   - `manifest.ts`  → 两段式清单抓取与 24h 磁盘缓存
 *   - `installer.ts` → 三态落盘、executable 识别、幂等判定
 *
 * 与 `src/core/launch/java.ts` 的分工（该文件由 lead 接线，本模块不 import、不修改）：
 *   - 本模块负责「没有就装」，产物落在 `<dataRoot>/java/<component>/`
 *   - launch/java.ts 负责「在已有目录里挑一个版本合适的 JRE」
 *   - 目录布局刻意与 `findJavaInDataRoot` 的搜索规则（`<dataRoot>/java` 下最深 4 层、
 *     相对路径第一段当组件名）对齐，因此接线只需「先 ensureRuntime，再 findJavaInDataRoot」。
 */

export { JavaRuntimeInstaller } from './installer.js';
export type {
  DownloaderLike,
  EnsureRuntimeProgress,
  JavaRuntimeInstallerDeps,
} from './installer.js';
export {
  findJavaEntry,
  isJavaExecutableName,
  countEntryTypes,
  pickRuntimeEntry,
  planRuntimeFiles,
  normalizeRelative,
  joinRelative,
} from './installer.js';
export type { RuntimeFilePlan } from './installer.js';

export {
  ManifestStore,
  DEFAULT_MANIFEST_TTL_MS,
  JAVA_RUNTIME_PRODUCT_URL,
  MANIFEST_CACHE_FILE,
  MANIFEST_META_FILE,
  entriesForComponent,
  allEntriesForComponent,
  listComponents,
  isRuntimeManifest,
  withMirror,
} from './manifest.js';
export type {
  JavaRuntimeEntry,
  JavaRuntimeFileEntry,
  JavaRuntimeFileType,
  JavaRuntimeFilesManifest,
  JavaRuntimeManifest,
  ManifestCacheMeta,
  TextFetcher,
} from './manifest.js';

export {
  KNOWN_COMPONENT_MAJORS,
  majorFromComponentName,
  parseMajorFromVersionName,
  pickAvailablePlatform,
  platformCandidates,
  primaryPlatform,
} from './platform.js';
export type { PlatformInput, RuntimeArch, RuntimePlatform } from './platform.js';

/** 契约里点名的「组件 + 主版本」结构。 */
export interface JavaComponent {
  /** 如 java-runtime-gamma */
  name: string;
  /** 如 17 / 21 */
  majorVersion: number;
}
