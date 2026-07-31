import { describe, expect, it } from 'vitest';
import { resolve } from '../src/workspace-safety/__fixtures__/ordinary-windows-test-loader.mjs';
import { resolve as resolvePathOnly } from '../src/workspace-safety/__fixtures__/ordinary-windows-path-test-loader.mjs';

const fixturesRoot = new URL('../src/workspace-safety/__fixtures__/', import.meta.url);
const sourceRoot = new URL('../src/workspace-safety/', import.meta.url);

function captureResolution() {
  const calls = [];
  return {
    calls,
    nextResolve: (specifier, context) => {
      calls.push({ specifier: String(specifier), parentURL: context.parentURL });
      return { url: String(specifier) };
    },
  };
}

describe('ordinary Windows child-process test resolver', () => {
  it.each(['js', 'ts'])('maps only the exact path transport %s target', async (extension) => {
    const capture = captureResolution();
    const parentURL = new URL('windows-path-attributes.ts', sourceRoot).href;
    const result = await resolve(
      `./windows-path-attributes-transport.${extension}`,
      { parentURL },
      capture.nextResolve,
    );

    expect(result).toEqual({
      url: new URL('windows-path-attributes-test-transport.ts', sourceRoot).href,
    });
    expect(capture.calls).toHaveLength(1);
  });

  it.each(['js', 'ts'])('maps only the exact identity transport %s target', async (extension) => {
    const capture = captureResolution();
    const parentURL = new URL('identity.ts', sourceRoot).href;
    const result = await resolve(
      `./windows-identity-transport.${extension}`,
      { parentURL },
      capture.nextResolve,
    );

    expect(result).toEqual({ url: new URL('windows-identity-test-transport.ts', sourceRoot).href });
    expect(capture.calls).toHaveLength(1);
  });

  it('keeps production identity while replacing paths for a native-supervisor fixture', async () => {
    const identityCapture = captureResolution();
    const identityParent = new URL('identity.ts', sourceRoot).href;
    const identitySpecifier = './windows-identity-transport.ts';
    await expect(
      resolvePathOnly(
        identitySpecifier,
        { parentURL: identityParent },
        identityCapture.nextResolve,
      ),
    ).resolves.toEqual({ url: identitySpecifier });

    const pathCapture = captureResolution();
    const pathParent = new URL('windows-path-attributes.ts', sourceRoot).href;
    await expect(
      resolvePathOnly(
        './windows-path-attributes-transport.ts',
        { parentURL: pathParent },
        pathCapture.nextResolve,
      ),
    ).resolves.toEqual({
      url: new URL('windows-path-attributes-test-transport.ts', sourceRoot).href,
    });
  });

  it('leaves a same-named import from every other parent unchanged', async () => {
    const capture = captureResolution();
    const parentURL = new URL('unrelated.ts', fixturesRoot).href;
    const specifier = '../windows-path-attributes-transport.ts';
    const result = await resolve(specifier, { parentURL }, capture.nextResolve);

    expect(result).toEqual({ url: specifier });
    expect(capture.calls).toEqual([{ specifier, parentURL }]);
  });
});
