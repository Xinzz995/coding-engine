const PATH_ATTRIBUTES_PARENT = new URL('../windows-path-attributes.ts', import.meta.url).href;
const PATH_ATTRIBUTES_PRODUCTION_TRANSPORTS = new Set([
  new URL('../windows-path-attributes-transport.js', import.meta.url).href,
  new URL('../windows-path-attributes-transport.ts', import.meta.url).href,
]);
const PATH_ATTRIBUTES_TEST_TRANSPORT = new URL(
  '../windows-path-attributes-test-transport.ts',
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === PATH_ATTRIBUTES_PARENT) {
    const resolvedFromParent = new URL(specifier, context.parentURL).href;
    if (PATH_ATTRIBUTES_PRODUCTION_TRANSPORTS.has(resolvedFromParent)) {
      return nextResolve(PATH_ATTRIBUTES_TEST_TRANSPORT, context);
    }
  }
  return nextResolve(specifier, context);
}
