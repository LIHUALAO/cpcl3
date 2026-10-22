/**
 * Java 相关类型的收敛点。
 *
 * 原本 `JavaRequirement` 定义在 `java.ts` 里，但 `java.ts` 现在还要 import 本模块
 * （启动期自动下载需要 `JavaAutoProvisioner`），直接互相 import 会成环。
 * 把纯类型抽到这里，两条 import 路径都能干净地指向它。
 */

/** 版本 JSON 里 `javaVersion` 推导出的运行时要求 */
export interface JavaRequirement {
  /** 版本 JSON 里的 javaVersion.majorVersion；缺省按 8 */
  majorVersion: number;
  /** 版本 JSON 里的 javaVersion.component，如 jre-legacy / java-runtime-gamma */
  component?: string;
}
