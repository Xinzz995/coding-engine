import { readFileSync, writeFileSync } from 'node:fs';
import { jsonrepair } from 'jsonrepair';

export function repairJsonString(raw: string): string {
  const repaired = jsonrepair(raw);
  const parsed = JSON.parse(repaired); // second validation pass
  return JSON.stringify(parsed, null, 2);
}

export function repairPrdFile(path: string): void {
  const raw = readFileSync(path, 'utf-8');
  const repaired = repairJsonString(raw); // throws before any write if unrepairable
  writeFileSync(path, repaired, 'utf-8');
}
