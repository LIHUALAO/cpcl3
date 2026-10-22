/**
 * 网络层引导：把 config 模块的代理配置接到 download 模块的传输层。
 *
 * 为什么需要这个中间层：`config` 模块明确**不能 import download**（文件头有注释，
 * 会成 ESM 循环依赖）。所以两边各留一个注入点：
 *
 *   config  → `setProxyApplier` / `setProxyDetector`（本模块往里塞实现）
 *   download → `setActiveProxy`（本模块往里塞解析后的代理）
 *
 * 本模块同时 import 两边，是唯一知道它们如何拼在一起的地方。
 * 应用启动时调用一次 {@link bootstrapNetwork} 即可。
 */

import { setActiveProxy } from '../download/transport.js';
import { parseProxyUrl } from '../download/proxy.js';
import { detectProxy } from './proxy-detect.js';
import {
  applyProxyFromConfig,
  setProxyApplier,
  setProxyDetector,
  type ProxyDetectorFn,
} from '../config/store.js';
import type { GlobalConfigStore } from '../config/store.js';

let bootstrapped = false;

/**
 * 注入 config 需要的两个回调。
 *
 * 幂等：重复调用只会再注入一次同样的实现，不会叠加。
 */
export function bootstrapNetwork(): void {
  // 1) 把「解析后的代理」写进 transport 的模块级变量
  setProxyApplier((proxy, bypass) => {
    if (proxy === null) {
      setActiveProxy(null);
      return;
    }
    const parsed = parseProxyUrl(proxy.url);
    if (parsed === undefined) {
      // 地址格式不对：宁可直连，也不要让所有请求卡在一个坏代理上
      process.emitWarning(`代理地址无法解析（${proxy.url}），已退回直连。`);
      setActiveProxy(null);
      return;
    }
    setActiveProxy(parsed);
    // bypass 通过 transport 的默认值生效；用户自定义的 bypass 会在 openRequest 的
    // 选项里带入（见 TransportOptions.proxyBypass）
    void bypass;
  });

  // 2) 把系统代理探测能力交给 config
  const detector: ProxyDetectorFn = async () => {
    const found = await detectProxy();
    return found === undefined ? undefined : { url: found.url, label: found.label };
  };
  setProxyDetector(detector);

  bootstrapped = true;
}

/** 引导并应用一次（幂等；启动时调用） */
export async function bootstrapAndApplyProxy(
  store?: GlobalConfigStore,
): Promise<{ applied: boolean; url?: string; bypass: string; reason?: string }> {
  if (!bootstrapped) bootstrapNetwork();
  return store === undefined ? applyProxyFromConfig() : applyProxyFromConfig(store);
}

/** 是否已完成引导（测试与诊断用） */
export function isNetworkBootstrapped(): boolean {
  return bootstrapped;
}
