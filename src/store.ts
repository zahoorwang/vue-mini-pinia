import {
  computed,
  ComputedRef,
  effectScope,
  EffectScope,
  inject,
  isReactive,
  isRef,
  markRaw,
  nextTick,
  reactive,
  toRaw,
  toRefs,
  UnwrapRef,
  watch,
  WatchOptions
} from '@vue-mini/core';

import {
  _ActionsTree,
  _DeepPartial,
  _ExtractActionsFromSetupStore,
  _ExtractGettersFromSetupStore,
  _ExtractStateFromSetupStore,
  _GettersTree,
  _Method,
  _StoreWithGetters,
  _StoreWithState,
  DefineSetupStoreOptions,
  DefineStoreOptions,
  DefineStoreOptionsInPlugin,
  isPlainObject,
  MutationType,
  StateTree,
  Store,
  StoreDefinition,
  StoreGeneric,
  StoreOnActionListener,
  SubscriptionCallback,
  SubscriptionCallbackMutation
} from './types';
import { activePinia, Pinia, piniaSymbol, setActivePinia } from './root-store';
import { addSubscription, noop, triggerSubscriptions } from './subscriptions';

type _ArrayType<AT> = AT extends Array<infer T> ? T : never;

/**
 * Marks a function as an action for `$onAction`
 * @internal
 */
const ACTION_MARKER = Symbol();
/**
 * Action name symbol. Allows to add a name to an action after defining it
 * @internal
 */
const ACTION_NAME = Symbol();
/**
 * Function type extended with action markers
 * @internal
 */
interface MarkedAction<Fn extends _Method = _Method> {
  (...args: Parameters<Fn>): ReturnType<Fn>;
  [ACTION_MARKER]: boolean;
  [ACTION_NAME]: string;
}

function mergeReactiveObjects<T extends Record<any, unknown> | Map<unknown, unknown> | Set<unknown>>(target: T, patchToApply: _DeepPartial<T>): T {
  // Handle Map instances
  if (target instanceof Map && patchToApply instanceof Map) {
    patchToApply.forEach((value, key) => target.set(key, value));
  } else if (target instanceof Set && patchToApply instanceof Set) {
    // Handle Set instances
    patchToApply.forEach(target.add, target);
  }

  // no need to go through symbols because they cannot be serialized anyway
  for (const key in patchToApply) {
    if (!patchToApply.hasOwnProperty(key)) continue;
    const subPatch = patchToApply[key];
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(subPatch) && target.hasOwnProperty(key) && !isRef(subPatch) && !isReactive(subPatch)) {
      // NOTE: here I wanted to warn about inconsistent types but it's not possible because in setup stores one might
      // start the value of a property as a certain type e.g. a Map, and then for some reason, during SSR, change that
      // to `undefined`. When trying to hydrate, we want to override the Map with `undefined`.
      target[key] = mergeReactiveObjects(targetValue, subPatch);
    } else {
      // @ts-expect-error: subPatch is a valid value
      target[key] = subPatch;
    }
  }

  return target;
}

const skipHydrateSymbol = Symbol();

/**
 * Tells Pinia to skip the hydration process of a given object. This is useful in setup stores (only) when you return a
 * stateful object in the store but it isn't really state. e.g. returning a router instance in a setup store.
 *
 * @param obj - target object
 * @returns obj
 */
export function skipHydrate<T = any>(obj: T): T {
  return Object.defineProperty(obj, skipHydrateSymbol, {});
}

/**
 * Returns whether a value should be hydrated
 *
 * @param obj - target variable
 * @returns true if `obj` should be hydrated
 */
export function shouldHydrate(obj: any) {
  return !isPlainObject(obj) || !obj.hasOwnProperty(skipHydrateSymbol);
}

const { assign } = Object;

function isComputed<T>(value: ComputedRef<T> | unknown): value is ComputedRef<T>;
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect);
}

function createOptionsStore<Id extends string, S extends StateTree, G extends _GettersTree<S>, A extends _ActionsTree>(
  id: Id,
  options: DefineStoreOptions<Id, S, G, A>,
  pinia: Pinia
): Store<Id, S, G, A> {
  const { state, actions, getters } = options;

  const initialState: StateTree | undefined = pinia.state.value[id];

  let store: Store<Id, S, G, A>;

  function setup() {
    if (!initialState) {
      pinia.state.value[id] = state ? state() : {};
    }

    // avoid creating a state in pinia.state.value
    const localState = toRefs(pinia.state.value[id]);

    return assign(
      localState,
      actions,
      Object.keys(getters || {}).reduce(
        (computedGetters, name) => {
          computedGetters[name] = markRaw(
            computed(() => {
              setActivePinia(pinia);
              // it was created just before
              const store = pinia._s.get(id)!;
              // @ts-expect-error
              return getters![name].call(store, store);
            })
          );
          return computedGetters;
        },
        {} as Record<string, ComputedRef>
      )
    );
  }

  store = createSetupStore(id, setup, options, pinia, true);

  return store as any;
}

function createSetupStore<Id extends string, SS extends Record<any, unknown>, S extends StateTree, G extends Record<string, _Method>, A extends _ActionsTree>(
  $id: Id,
  setup: (helpers: SetupStoreHelpers) => SS,
  options: DefineSetupStoreOptions<Id, S, G, A> | DefineStoreOptions<Id, S, G, A> = {},
  pinia: Pinia,
  isOptionsStore?: boolean
): Store<Id, S, G, A> {
  let scope!: EffectScope;

  const optionsForPlugin: DefineStoreOptionsInPlugin<Id, S, G, A> = assign({ actions: {} as A }, options);

  // watcher options for $subscribe
  const $subscribeOptions: WatchOptions = { deep: true };

  // internal state
  let isListening: boolean; // set to true at the end
  let isSyncListening: boolean; // set to true at the end
  let subscriptions: SubscriptionCallback<S>[] = [];
  let actionSubscriptions: StoreOnActionListener<Id, S, G, A>[] = [];

  const initialState = pinia.state.value[$id] as UnwrapRef<S> | undefined;

  // avoid setting the state for option stores if it is set by the setup
  if (!isOptionsStore && !initialState) {
    pinia.state.value[$id] = {};
  }

  // avoid triggering too many listeners
  // https://github.com/vuejs/pinia/issues/1129
  let activeListener: Symbol | undefined;
  function $patch(stateMutation: (state: UnwrapRef<S>) => void): void;
  function $patch(partialState: _DeepPartial<UnwrapRef<S>>): void;
  function $patch(partialStateOrMutator: _DeepPartial<UnwrapRef<S>> | ((state: UnwrapRef<S>) => void)): void {
    let subscriptionMutation: SubscriptionCallbackMutation<S>;
    isListening = isSyncListening = false;
    if (typeof partialStateOrMutator === 'function') {
      partialStateOrMutator(pinia.state.value[$id] as UnwrapRef<S>);
      subscriptionMutation = {
        type: MutationType.patchFunction,
        storeId: $id
      };
    } else {
      mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator);
      subscriptionMutation = {
        type: MutationType.patchObject,
        payload: partialStateOrMutator,
        storeId: $id
      };
    }
    const listenerId = (activeListener = Symbol());
    nextTick().then(() => {
      if (activeListener === listenerId) {
        isListening = true;
      }
    });
    isSyncListening = true;
    // because we paused the watcher, we need to manually call the subscriptions
    triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id] as UnwrapRef<S>);
  }

  const $reset = isOptionsStore
    ? function $reset(this: _StoreWithState<Id, S, G, A>) {
        const { state } = options as DefineStoreOptions<Id, S, G, A>;
        const newState: _DeepPartial<UnwrapRef<S>> = state ? state() : {};
        // we use a patch to group all changes into one single subscription
        this.$patch($state => {
          // @ts-expect-error: FIXME: shouldn't error?
          assign($state, newState);
        });
      }
    : noop;

  function $dispose() {
    scope.stop();
    subscriptions = [];
    actionSubscriptions = [];
    pinia._s.delete($id);
  }

  /**
   * Helper that wraps function so it can be tracked with $onAction
   * @param fn - action to wrap
   * @param name - name of the action
   */
  const action = <Fn extends _Method>(fn: Fn, name: string = ''): Fn => {
    if (ACTION_MARKER in fn) {
      // we ensure the name is set from the returned function
      (fn as unknown as MarkedAction<Fn>)[ACTION_NAME] = name;
      return fn;
    }

    const wrappedAction = function (this: any) {
      setActivePinia(pinia);
      const args = Array.from(arguments);

      const afterCallbackList: Array<(resolvedReturn: any) => any> = [];
      const onErrorCallbackList: Array<(error: unknown) => unknown> = [];
      function after(callback: _ArrayType<typeof afterCallbackList>) {
        afterCallbackList.push(callback);
      }
      function onError(callback: _ArrayType<typeof onErrorCallbackList>) {
        onErrorCallbackList.push(callback);
      }

      // @ts-expect-error
      triggerSubscriptions(actionSubscriptions, {
        args,
        name: wrappedAction[ACTION_NAME],
        store,
        after,
        onError
      });

      let ret: unknown;
      try {
        ret = fn.apply(this && this.$id === $id ? this : store, args);
        // handle sync errors
      } catch (error) {
        triggerSubscriptions(onErrorCallbackList, error);
        throw error;
      }

      if (ret instanceof Promise) {
        return ret
          .then(value => {
            triggerSubscriptions(afterCallbackList, value);
            return value;
          })
          .catch(error => {
            triggerSubscriptions(onErrorCallbackList, error);
            return Promise.reject(error);
          });
      }

      // trigger after callbacks
      triggerSubscriptions(afterCallbackList, ret);
      return ret;
    } as MarkedAction<Fn>;

    wrappedAction[ACTION_MARKER] = true;
    wrappedAction[ACTION_NAME] = name; // will be set later

    // @ts-expect-error: we are intentionally limiting the returned type to just Fn
    // because all the added properties are internals that are exposed through `$onAction()` only
    return wrappedAction;
  };

  const partialStore = {
    _p: pinia,
    // _s: scope,
    $id,
    $onAction: addSubscription.bind(null, actionSubscriptions),
    $patch,
    $reset,
    $subscribe(callback, options = {}) {
      const removeSubscription = addSubscription(subscriptions, callback, options.detached, () => stopWatcher());
      const stopWatcher = scope.run(() =>
        watch(
          () => pinia.state.value[$id] as UnwrapRef<S>,
          state => {
            if (options.flush === 'sync' ? isSyncListening : isListening) {
              callback({ storeId: $id, type: MutationType.direct }, state);
            }
          },
          assign({}, $subscribeOptions, options)
        )
      )!;

      return removeSubscription;
    },
    $dispose
  } as _StoreWithState<Id, S, G, A>;

  const store: Store<Id, S, G, A> = reactive(partialStore) as unknown as Store<Id, S, G, A>;

  // store the partial store now so the setup of stores can instantiate each other before they are finished without
  // creating infinite loops.
  pinia._s.set($id, store as Store);

  const setupStore = pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!)!;

  // overwrite existing actions to support $onAction
  for (const key in setupStore) {
    const prop = setupStore[key];

    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      // mark it as a piece of state to be serialized
      if (!isOptionsStore) {
        // in setup stores we must hydrate the state and sync pinia state tree with the refs the user just created
        if (initialState && shouldHydrate(prop)) {
          if (isRef(prop)) {
            prop.value = initialState[key as keyof UnwrapRef<S>];
          } else {
            // probably a reactive object, lets recursively assign
            // @ts-expect-error: prop is unknown
            mergeReactiveObjects(prop, initialState[key]);
          }
        }
        // transfer the ref to the pinia state to keep everything in sync
        pinia.state.value[$id][key] = prop;
      }
      // action
    } else if (typeof prop === 'function') {
      const actionValue = action(prop as _Method, key);
      // this a hot module replacement store because the hotUpdate method needs
      // to do it with the right context
      // @ts-expect-error
      setupStore[key] = actionValue;

      // list actions so they can be used in plugins
      // @ts-expect-error
      optionsForPlugin.actions[key] = prop;
    }
  }

  // add the state, getters, and action properties
  assign(store, setupStore);
  // allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
  // Make `storeToRefs()` work with `reactive()` #799
  assign(toRaw(store), setupStore);

  // use this instead of a computed with setter to be able to create it anywhere
  // without linking the computed lifespan to wherever the store is first
  // created.
  Object.defineProperty(store, '$state', {
    get: () => pinia.state.value[$id],
    set: state => {
      $patch($state => {
        // @ts-expect-error: FIXME: shouldn't error?
        assign($state, state);
      });
    }
  });

  // avoid listing internal properties in devtools
  (['_p', '_hmrPayload', '_getters', '_customProperties'] as const).forEach(p => {
    Object.defineProperty(store, p, assign({ value: (store as any)[p] }, { writable: true, configurable: true, enumerable: false }));
  });

  // apply all plugins
  pinia._p.forEach(extender => {
    assign(store, scope.run(() => extender({ store: store as Store, app: pinia._a, pinia, options: optionsForPlugin }))!);
  });

  // only apply hydrate to option stores with an initial state in pinia
  if (initialState && isOptionsStore && (options as DefineStoreOptions<Id, S, G, A>).hydrate) {
    (options as DefineStoreOptions<Id, S, G, A>).hydrate!(store.$state, initialState);
  }

  isListening = true;
  isSyncListening = true;
  return store;
}

/**
 * Extract the actions of a store type. Works with both a Setup Store or an
 * Options Store.
 */
export type StoreActions<SS> = SS extends Store<string, StateTree, _GettersTree<StateTree>, infer A> ? A : _ExtractActionsFromSetupStore<SS>;

/**
 * Extract the getters of a store type. Works with both a Setup Store or an
 * Options Store.
 */
export type StoreGetters<SS> = SS extends Store<string, StateTree, infer G, _ActionsTree> ? _StoreWithGetters<G> : _ExtractGettersFromSetupStore<SS>;

/**
 * Extract the state of a store type. Works with both a Setup Store or an
 * Options Store. Note this unwraps refs.
 */
export type StoreState<SS> = SS extends Store<string, infer S, _GettersTree<StateTree>, _ActionsTree> ? UnwrapRef<S> : _ExtractStateFromSetupStore<SS>;

export interface SetupStoreHelpers {
  action: <Fn extends _Method>(fn: Fn) => Fn;
}

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param id - id of the store (must be unique)
 * @param options - options to define the store
 */
export function defineStore<
  Id extends string,
  S extends StateTree = {},
  G extends _GettersTree<S> = {},
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */ = {}
>(id: Id, options: Omit<DefineStoreOptions<Id, S, G, A>, 'id'>): StoreDefinition<Id, S, G, A>;

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param options - options to define the store
 */
export function defineStore<
  Id extends string,
  S extends StateTree = {},
  G extends _GettersTree<S> = {},
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */ = {}
>(options: DefineStoreOptions<Id, S, G, A>): StoreDefinition<Id, S, G, A>;

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param id - id of the store (must be unique)
 * @param storeSetup - function that defines the store
 * @param options - extra options
 */
export function defineStore<Id extends string, SS>(
  id: Id,
  storeSetup: (helpers: SetupStoreHelpers) => SS,
  options?: DefineSetupStoreOptions<Id, _ExtractStateFromSetupStore<SS>, _ExtractGettersFromSetupStore<SS>, _ExtractActionsFromSetupStore<SS>>
): StoreDefinition<Id, _ExtractStateFromSetupStore<SS>, _ExtractGettersFromSetupStore<SS>, _ExtractActionsFromSetupStore<SS>>;

export function defineStore(idOrOptions: any, setup?: any, setupOptions?: any): StoreDefinition {
  let id: string;
  let options: DefineStoreOptions<string, StateTree, _GettersTree<StateTree>, _ActionsTree> | DefineSetupStoreOptions<string, StateTree, _GettersTree<StateTree>, _ActionsTree>;

  const isSetupStore = typeof setup === 'function';
  if (typeof idOrOptions === 'string') {
    id = idOrOptions;
    // the option store setup will contain the actual options in this case
    options = isSetupStore ? setupOptions : setup;
  } else {
    options = idOrOptions;
    id = idOrOptions.id;
  }

  function useStore(pinia?: Pinia | null): StoreGeneric {
    pinia = inject(piniaSymbol, null) || null;

    if (pinia) setActivePinia(pinia);

    pinia = activePinia!;

    if (!pinia._s.has(id)) {
      // creating the store registers it in `pinia._s`
      if (isSetupStore) {
        createSetupStore(id, setup, options, pinia);
      } else {
        createOptionsStore(id, options as any, pinia);
      }
    }

    const store: StoreGeneric = pinia._s.get(id)!;

    // StoreGeneric cannot be casted towards Store
    return store as any;
  }

  useStore.$id = id;

  return useStore;
}

/**
 * Return type of `defineStore()` with a setup function.
 * - `Id` is a string literal of the store's name
 * - `SS` is the return type of the setup function
 * @see {@link StoreDefinition}
 */
export interface SetupStoreDefinition<Id extends string, SS>
  extends StoreDefinition<Id, _ExtractStateFromSetupStore<SS>, _ExtractGettersFromSetupStore<SS>, _ExtractActionsFromSetupStore<SS>> {}
