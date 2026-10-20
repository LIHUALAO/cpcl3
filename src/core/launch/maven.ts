/** Maven 坐标与版本目录路径的工具函数。 */

/**
 * 解析 Maven 坐标 `group:artifact:version[:classifier]`。
 * 少于 3 段时返回 null —— 这种坐标无法拼出路径。
 */
export function parseMavenCoordinate(
  coordinate: string,
): { group: string; artifact: string; version: string; classifier?: string } | null {
  const parts = coordinate.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;
  return classifier ? { group, artifact, version, classifier } : { group, artifact, version };
}

/** 按 Maven 仓库布局拼相对路径：group 的 `.` 换成 `/` */
export function mavenRelativePath(coordinate: string): string | null {
  const c = parseMavenCoordinate(coordinate);
  if (!c) return null;
  const dir = `${c.group.replace(/\./g, '/')}/${c.artifact}/${c.version}`;
  const file = c.classifier
    ? `${c.artifact}-${c.version}-${c.classifier}.jar`
    : `${c.artifact}-${c.version}.jar`;
  return `${dir}/${file}`;
}
