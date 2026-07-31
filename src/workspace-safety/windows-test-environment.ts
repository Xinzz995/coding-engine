const WINDOWS_TARGET_BASELINE = ['SystemRoot', 'TEMP', 'TMP'] as const;

function requiredEnvironmentValue(name: (typeof WINDOWS_TARGET_BASELINE)[number]): string {
  const keys = Object.keys(process.env).filter(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (keys.length !== 1) throw new Error(`required Windows test environment ${name} is ambiguous`);
  const value = process.env[keys[0]];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`required Windows test environment ${name} is unavailable`);
  }
  return value;
}

export function windowsTestTargetEnvironment(): readonly {
  readonly name: string;
  readonly value: string;
}[] {
  return WINDOWS_TARGET_BASELINE.map((name) => ({
    name,
    value: requiredEnvironmentValue(name),
  }));
}
