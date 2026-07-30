export {
  DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS,
  WINDOWS_SUPERVISOR_SCRIPT,
  WINDOWS_SUPERVISOR_SOURCES,
  createWindowsSupervisorLaunch,
  readWindowsSupervisorAssets,
  spawnWindowsJobSupervisor,
} from './windows-supervisor-launch.js';
export type {
  CreateWindowsSupervisorLaunchOptions,
  WindowsSupervisorAssets,
  WindowsSupervisorLaunch,
  WindowsSupervisorTimeouts,
} from './windows-supervisor-launch.js';

export {
  WindowsSupervisorEventOrder,
  parseWindowsSupervisorEvent,
} from './windows-supervisor-protocol.js';
export type {
  RunDarkWindowsSupervisedOperationOptions,
  WindowsArmedEvent,
  WindowsBoundEvent,
  WindowsDrainedEvent,
  WindowsInvocationOutcome,
  WindowsOutputEvent,
  WindowsParsedEvent,
  WindowsProtocolEvent,
  WindowsResultEvent,
  WindowsStartedEvent,
  WindowsSupervisorHooks,
} from './windows-supervisor-protocol.js';

export {
  readDarkWindowsHelperBundle,
  runDarkWindowsSupervisedOperation,
} from './windows-supervisor-integration.js';
