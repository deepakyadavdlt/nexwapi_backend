/** Wrap Express 4 route handlers so async rejections reach error middleware (no hung requests). */
export function patchAsyncRouter(router) {
  for (const method of ["get", "post", "put", "patch", "delete", "all"]) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => {
      const wrapped = handlers.map((handler) => {
        if (typeof handler !== "function") return handler;
        if (handler.length >= 4) return handler;
        return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
      });
      return original(path, ...wrapped);
    };
  }
  return router;
}
