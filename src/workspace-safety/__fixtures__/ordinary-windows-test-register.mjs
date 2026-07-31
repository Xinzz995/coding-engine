import { register } from 'node:module';

// `tsx` is preloaded first by the test launcher. Register this resolver second so it can replace
// the two exact production transports before handing the TypeScript target back to tsx.
register(new URL('./ordinary-windows-test-loader.mjs', import.meta.url));
