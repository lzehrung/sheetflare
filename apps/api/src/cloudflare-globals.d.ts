import type * as MainModule from './index';

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof MainModule;
      durableNamespaces: 'ControlPlaneDO' | 'ProjectDO' | 'TableDO' | 'RateLimitDO';
    }
  }
}

export {};
