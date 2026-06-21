import { defineRouter } from '#q-app';
import { routes, handleHotUpdate } from 'vue-router/auto-routes';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';

/*
 * If not building with SSR mode, you can
 * directly export the Router instantiation;
 *
 * The function below can be async too; either use
 * async/await or return a Promise which resolves
 * with the Router instance.
 */

export default defineRouter((/* { store, ssrContext } */) => {
  const createHistory = import.meta.env.QUASAR_SERVER
    ? createMemoryHistory
    : (import.meta.env.QUASAR_VUE_ROUTER_MODE === 'history' ? createWebHistory : createWebHashHistory);

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,

    // Leave this as is and make changes in quasar.conf.js instead!
    // quasar.conf.js -> build -> vueRouterMode
    // quasar.conf.js -> build -> publicPath
    history: createHistory(import.meta.env.QUASAR_VUE_ROUTER_BASE)
  });

  // enable HMR for it
  if (import.meta.hot) {
    handleHotUpdate(Router);
  }

  // Recover from a stale build: when a route's code-split chunk 404s (the bundle was rebuilt
  // while this tab stayed open), a one-time reload pulls the fresh index + chunks instead of
  // leaving the route silently dead. The flag prevents a reload loop if it's a real failure.
  Router.onError((err, to) => {
    const msg = String((err as Error)?.message ?? err);
    if (/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(msg)) {
      if (!sessionStorage.getItem('chunkReloaded')) {
        sessionStorage.setItem('chunkReloaded', '1');
        window.location.assign(to.fullPath);
      }
    }
  });
  Router.afterEach(() => sessionStorage.removeItem('chunkReloaded'));

  return Router;
});
