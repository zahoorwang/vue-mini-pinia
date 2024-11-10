import { effectScope, markRaw, provide, ref, Ref } from "@vue-mini/core";

import { Pinia, PiniaPlugin, setActivePinia, piniaSymbol } from "./root-store";
import { StateTree, StoreGeneric, App } from "./types";

/**
 * Creates a Pinia instance to be used by the application
 */
export function createPinia(): Pinia {
  const scope = effectScope(true);
  const state = scope.run<Ref<Record<string, StateTree>>>(() =>
    ref<Record<string, StateTree>>({}),
  )!;

  let _p: Pinia["_p"] = [];
  let toBeInstalled: PiniaPlugin[] = [];

  const pinia: Pinia = markRaw({
    use(plugin) {
      if (!this._a) {
        toBeInstalled.push(plugin);
      } else {
        _p.push(plugin);
      }
      return this;
    },

    _p,
    _a: null,
    _e: scope,
    _s: new Map<string, StoreGeneric>(),
    state,
  });

  function install(app: App) {
    setActivePinia(pinia);

    // const OriginalPage = Page;
    // Page = function (config) {
    //   // @ts-ignore
    //   return (config.$pinia = pinia), OriginalPage(config);
    // };

    pinia._a = app;
    provide(piniaSymbol, pinia);

    toBeInstalled.forEach((plugin) => _p.push(plugin));
    toBeInstalled = [];

    console.log("🍍 Pinia Launched");
  }

  return install(getApp({ allowDefault: true })), pinia;
}

export function disposePinia(pinia: Pinia) {
  pinia._e.stop();
  pinia._s.clear();
  pinia._p.splice(0);
  pinia.state.value = {};
  // @ts-ignore
  pinia._a = null;
}
