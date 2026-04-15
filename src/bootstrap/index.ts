export { BootstrapOrchestrator } from './orchestrator.js'
export type { OrchestratorOptions } from './orchestrator.js'

export { BootstrapStateStore } from './state-store.js'
export type { BootstrapStateStoreOptions } from './state-store.js'

export {
  defaultKeypairDirectory,
  encodeOpenSshPublicKey,
  fileExists,
  generateEd25519Keypair,
  saveKeypair,
  sha256Fingerprint,
} from './keypair.js'
export type {
  GeneratedKeypair,
  SaveKeypairOptions,
  SavedKeypairPaths,
} from './keypair.js'

export { authStage } from './stages/00-auth.js'
export {
  defaultPrivateKeyPathFor,
  defaultSshKeyStage,
  sshKeyStage,
} from './stages/01-ssh-key.js'
export type { SshKeyStageOptions } from './stages/01-ssh-key.js'
export { provisionStage } from './stages/02-provision.js'
export type { ProvisionStageOptions } from './stages/02-provision.js'
export { waitSshStage } from './stages/03-wait-ssh.js'
export type { WaitSshStageOptions } from './stages/03-wait-ssh.js'
export { cloudInitStage } from './stages/04-cloud-init.js'
export type { CloudInitStageOptions } from './stages/04-cloud-init.js'
export {
  installRuntimeStage,
  resolveLocalWorkerdBinary,
} from './stages/05-install-runtime.js'
export type { InstallRuntimeStageOptions } from './stages/05-install-runtime.js'
export { installServicesStage } from './stages/06-install-services.js'
export type { InstallServicesStageOptions } from './stages/06-install-services.js'

export { runBootstrap } from './run.js'
export type { RunBootstrapOptions } from './run.js'

export {
  BootstrapError,
  type BootstrapContext,
  type BootstrapState,
  type LogFn,
  type LogLevel,
  type Stage,
} from './types.js'
