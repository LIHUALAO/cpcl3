/**
 * Mojang 官方与国内镜像端点常量。
 *
 * CLI 的 `doctor` 与 install 的 URL 选择都从这里取值，保证「一套常量，两处一致」。
 */

/** 官方版本清单（launchermeta，较慢但字段全） */
export const MOJANG_MANIFEST_URL =
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

/** 官方 piston-meta 镜像的版本清单（与上面内容一致，CDN 更快） */
export const PISTON_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

/** 官方资源（assets）根；不存在的对象会返回 404，这是正常探测语义 */
export const MOJANG_RESOURCES_ROOT = 'https://resources.download.minecraft.net/';

/** 官方库根 */
export const MOJANG_LIBRARIES_ROOT = 'https://libraries.minecraft.net/';

/** BMCLAPI 根（国内镜像，注意正确域名是 bangbang93.com） */
export const BMCLAPI_ROOT = 'https://bmclapi2.bangbang93.com/';

/** BMCLAPI 资源前缀 —— install 里 asset 下载优先用它 */
export const BMCLAPI_ASSET_PREFIX = `${BMCLAPI_ROOT}assets/`;

/** 微软设备码端点 */
export const MS_DEVICE_CODE_URL =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';

/** 微软令牌端点 */
export const MS_TOKEN_URL =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

/** Xbox Live 认证端点（doctor 顺带探测，客户端本身让 auth 模块用） */
export const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';

/** XSTS 授权端点 */
export const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';

/** Minecraft 服务端登录端点 */
export const MC_AUTH_URL =
  'https://api.minecraftservices.com/authentication/login_with_xbox';

/** 一个用于探测「库下载是否可达」的小文件（log4j 的 pom） */
export const LIBRARY_PROBE_URL =
  'https://libraries.minecraft.net/org/apache/logging/log4j/log4j-core/2.17.1/log4j-core-2.17.1.pom';

/** 一个用于探测「asset 下载是否可达」的固定对象（legacy index 里的 icon） */
export const ASSET_PROBE_HASH = 'bdf48ef6b5d0d23bbb02e17d04865216179f510a';

/** 一个用于探测「client.jar 是否可达」的固定对象头（1.21 client.jar） */
export const PISTON_DATA_PROBE_URL =
  'https://piston-data.mojang.com/v1/objects/0e9a07b9bb3390602f977073aa12884a4ce12431/client.jar';
