import { beforeEach } from 'vitest';
import { resetWindowsPathAttributeTestTransport } from './windows-path-attributes-test-transport.js';

// The deterministic transport protects each test from an unbounded helper loop. The counter must
// not couple unrelated tests or make a larger serial suite fail only because earlier tests ran.
beforeEach(() => {
  resetWindowsPathAttributeTestTransport();
});
