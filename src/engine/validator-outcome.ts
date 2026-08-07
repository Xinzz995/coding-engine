export type ValidatorRunnerOutcome = 'completed' | 'timeout' | 'error' | 'skipped' | undefined;
export type ValidatorProtocolOutcome = 'passed' | 'failed' | 'invalid' | undefined;
export type ValidatorAttemptOutcome = 'passed' | 'failed' | 'unverifiable' | 'not-run';

/**
 * Validator 的进程结局、结构化协议和引擎凭证必须在一个地方组合裁决。
 * 调用方不得把自由文本、结果文件存在或单独的 exit=0 当作通过。
 */
export function classifyValidatorAttempt(input: {
  readonly expected: boolean;
  readonly runnerOutcome: ValidatorRunnerOutcome;
  readonly protocol: ValidatorProtocolOutcome;
  readonly receiptIssued: boolean;
}): ValidatorAttemptOutcome {
  if (!input.expected) return 'not-run';
  if (input.runnerOutcome === 'completed' && input.protocol === 'passed' && input.receiptIssued) {
    return 'passed';
  }
  if (input.runnerOutcome === 'completed' && input.protocol === 'failed' && !input.receiptIssued) {
    return 'failed';
  }
  return 'unverifiable';
}
