const INLINE_ARGUMENT_CHUNK_CHARACTERS = 4_000;
const INLINE_ARGUMENT_TOTAL_CHARACTERS = 24_000;

const COMMON_JS_LOADER = String.raw`'use strict';
const sourceCount = Number(process.argv[1]);
const payloadCount = Number(process.argv[2]);
if (!Number.isSafeInteger(sourceCount) || sourceCount < 1 || !Number.isSafeInteger(payloadCount) || payloadCount < 1) throw new Error('inline program counts are invalid');
const sourceStart = 3;
const payloadStart = sourceStart + sourceCount;
const end = payloadStart + payloadCount;
if (end !== process.argv.length) throw new Error('inline program arguments are invalid');
const source = Buffer.from(process.argv.slice(sourceStart, payloadStart).join(''), 'base64url').toString('utf8');
const payload = Buffer.from(process.argv.slice(payloadStart, end).join(''), 'base64url').toString('utf8');
process.argv = [process.argv[0], payload];
Function('require', 'process', 'Buffer', source)(require, process, Buffer);`;

const MODULE_LOADER = String.raw`const sourceCount = Number(process.argv[1]);
const payloadCount = Number(process.argv[2]);
if (!Number.isSafeInteger(sourceCount) || sourceCount < 1 || !Number.isSafeInteger(payloadCount) || payloadCount < 1) throw new Error('inline program counts are invalid');
const sourceStart = 3;
const payloadStart = sourceStart + sourceCount;
const end = payloadStart + payloadCount;
if (end !== process.argv.length) throw new Error('inline program arguments are invalid');
const source = Buffer.from(process.argv.slice(sourceStart, payloadStart).join(''), 'base64url');
const payload = Buffer.from(process.argv.slice(payloadStart, end).join(''), 'base64url').toString('utf8');
process.argv = [process.argv[0], payload];
await import('data:text/javascript;base64,' + source.toString('base64'));`;

export class InlineProgramTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InlineProgramTransportError';
  }
}

function chunks(value: string): string[] {
  const encoded = Buffer.from(value, 'utf8').toString('base64url');
  if (encoded.length === 0) return [''];
  const result: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += INLINE_ARGUMENT_CHUNK_CHARACTERS) {
    result.push(encoded.slice(offset, offset + INLINE_ARGUMENT_CHUNK_CHARACTERS));
  }
  return result;
}

function boundedArguments(prefix: readonly string[], program: string, payload: string): string[] {
  if (program.length === 0) throw new InlineProgramTransportError('固定程序不能为空');
  const sourceChunks = chunks(program);
  const payloadChunks = chunks(payload);
  const args = [
    ...prefix,
    String(sourceChunks.length),
    String(payloadChunks.length),
    ...sourceChunks,
    ...payloadChunks,
  ];
  if (args.some((value) => value.length > INLINE_ARGUMENT_CHUNK_CHARACTERS)) {
    throw new InlineProgramTransportError('固定程序参数分块超过受管协议上限');
  }
  const total = args.reduce((sum, value) => sum + value.length, 0);
  if (total > INLINE_ARGUMENT_TOTAL_CHARACTERS) {
    throw new InlineProgramTransportError('固定程序与请求超过跨平台命令行上限');
  }
  return args;
}

/** 固定 CommonJS 程序来自当前进程内存；payload 在子进程中成为 process.argv[1]。 */
export function inlineCommonJsArguments(program: string, payload: string): string[] {
  return boundedArguments(['-e', COMMON_JS_LOADER], program, payload);
}

/** 固定 ESM 程序来自当前进程内存；payload 在子进程中成为 process.argv[1]。 */
export function inlineModuleArguments(program: string, payload: string): string[] {
  return boundedArguments(['--input-type=module', '-e', MODULE_LOADER], program, payload);
}
