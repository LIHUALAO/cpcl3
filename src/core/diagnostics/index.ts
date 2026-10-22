/**
 * diagnostics 模块 —— 崩溃日志基础分析。
 *
 * 出口只有三样：
 *   `CrashAnalyzer`         日志文本 / 实例目录 → CrashFinding[]
 *   `summarizeFindings()`   把 findings 压成一段人话（Web 任务面板用）
 *   `analyzeJobLog()`       从任务日志里就地分析（启动失败时无需等崩盘文件落盘）
 */

export {
  CrashAnalyzer,
  DEFAULT_MAX_BYTES,
  MAX_EVIDENCE,
  detectJavaMajor,
  extractMissingPath,
  extractModIds,
  javaVersionOfClassFile,
  parseXmxMb,
  type AnalyzeInstanceResult,
  type CrashAnalyzerOptions,
  type CrashFinding,
  type CrashKind,
} from './CrashAnalyzer.js';

import type { CrashFinding } from './CrashAnalyzer.js';

/**
 * 把分析结果压成给用户看的一段话。
 *
 * 规则：
 *   - 没有 finding → 明确说「没认出原因」，不假装分析成功
 *   - 有 finding → 逐条 `结论：` + 证据缩进；详情单独一段
 *   - 顺序保持分析器给的顺序（越靠前越可能是主因）
 */
export function summarizeFindings(findings: readonly CrashFinding[], opts: { maxEvidence?: number } = {}): string {
  if (findings.length === 0) {
    return '没有从日志里认出已知的崩溃原因。可以点「查看原始日志」，把完整堆栈贴到问题反馈里。';
  }
  const maxEvidence = Math.max(0, Math.floor(opts.maxEvidence ?? 3));
  const parts: string[] = [];
  findings.forEach((finding, index) => {
    const head = `【${String(index + 1)}】${finding.title}`;
    const lines = [head];
    if (finding.detail.length > 0) lines.push(finding.detail);
    if (maxEvidence > 0 && finding.evidence.length > 0) {
      lines.push('证据：');
      for (const line of finding.evidence.slice(0, maxEvidence)) lines.push(`  ${line}`);
    }
    parts.push(lines.join('\n'));
  });
  return parts.join('\n\n');
}

/**
 * 从一段「任务日志」直接分析（不落盘）。
 *
 * 用途：启动任务失败时，console 输出已经到了任务日志里，但 Minecraft 的
 * crash-report 文件可能还没写完（或者根本没写到实例目录）。此时直接从内存里
 * 的日志行分析，比等文件快得多，也不会因为没文件就说「没有崩溃」。
 *
 * 说明：这里接收的是 JobTable 的日志行（`{ level, text }`），只取 error/warn 与全部正文。
 */
export function analyzeJobLog(
  analyzer: CrashAnalyzerLike,
  lines: readonly { level: string; text: string }[],
): CrashFinding[] {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  // 保留顺序：正常输出与错误输出混在一起，规则需要上下文（例如 java version 在头部）
  const text = lines.map((l) => (typeof l.text === 'string' ? l.text : '')).join('\n');
  return analyzer.analyze(text);
}

/** 结构约束：便于 HTTP 层塞 fake 而不引入真实类 */
export interface CrashAnalyzerLike {
  analyze(logText: string): CrashFinding[];
}
