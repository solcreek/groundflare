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

export {
  BootstrapError,
  type BootstrapContext,
  type BootstrapState,
  type LogFn,
  type LogLevel,
  type Stage,
} from './types.js'
