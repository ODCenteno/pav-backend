const { translateUploadError } = require('./utils/spanish-errors');

function wrapUploadMethods(controller) {
  const methodsToWrap = ['upload', 'uploadFiles', 'replaceFile'];

  for (const methodName of methodsToWrap) {
    if (typeof controller[methodName] !== 'function') continue;

    const original = controller[methodName];
    controller[methodName] = async (ctx) => {
      try {
        return await original.call(controller, ctx);
      } catch (error) {
        throw translateUploadError(error);
      }
    };
  }

  return controller;
}

module.exports = (plugin) => {
  wrapUploadMethods(plugin.controllers['admin-upload']);

  const originalContentApiFactory = plugin.controllers['content-api'];
  plugin.controllers['content-api'] = ({ strapi }) => {
    const instance = originalContentApiFactory({ strapi });
    return wrapUploadMethods(instance);
  };

  return plugin;
};
