module.exports = function plugin(handler) {
  const pluginFn = (...args) => handler && handler(...args);
  pluginFn.__isOptionsFunction = true;
  return pluginFn;
};
