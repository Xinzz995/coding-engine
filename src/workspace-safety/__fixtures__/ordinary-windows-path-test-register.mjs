import { register } from 'node:module';

// This narrower resolver is for ordinary fixtures that start the real Windows supervisor. Their
// path checks remain deterministic, but process identity must stay native so it matches BOUND.
register(new URL('./ordinary-windows-path-test-loader.mjs', import.meta.url));
