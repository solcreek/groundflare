/**
 * Stage 0 — Provider authentication.
 *
 * Loads the provider token from the SecretStore, calls
 * provider.authenticate(), and records the resulting Account on the
 * shared bootstrap state.
 *
 * Idempotency: the persisted state's `account` field is the contract.
 * On resume we re-verify the token (cheap call) so a rotated/revoked
 * token surfaces here rather than in a downstream stage.
 */

import { ProviderError } from '../../provider/index.js'
import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'provider.auth'

export const authStage: Stage = {
  id: STAGE_ID,
  description: 'Authenticate with the VPS provider',

  async isComplete(ctx) {
    if (ctx.state.account === undefined) return false
    // Re-verify on resume so a revoked token fails here, not later.
    try {
      const token = await loadToken(ctx.secrets, ctx.provider.name)
      const account = await ctx.provider.authenticate(token)
      // If the account ID changed (token rotated to a different project),
      // treat the stage as not-complete and re-run normally.
      return account.id === ctx.state.account.id
    } catch (err) {
      if (err instanceof BootstrapError && err.code === 'prerequisite') {
        // Token missing — stage will fail in run(); flag as not complete.
        return false
      }
      // Surface the underlying error rather than silently re-running.
      throw err
    }
  },

  async run(ctx) {
    const token = await loadToken(ctx.secrets, ctx.provider.name)
    let account
    try {
      account = await ctx.provider.authenticate(token)
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) {
        throw new BootstrapError(
          `provider rejected the token (HTTP 401). ` +
            `Update it via \`groundflare secret set provider.${ctx.provider.name}.token <new-token>\`.`,
          'stage_failed',
          STAGE_ID,
          { cause: err },
        )
      }
      throw err
    }
    ctx.state.account = { id: account.id, name: account.name }
    ctx.log('info', `authenticated as ${account.name} (${account.id})`)
  },
}

async function loadToken(
  secrets: Parameters<Stage['run']>[0]['secrets'],
  providerName: string,
): Promise<string> {
  const key = `provider.${providerName}.token`
  const token = await secrets.get(key)
  if (token === null || token.length === 0) {
    throw new BootstrapError(
      `no provider token found at secret ${JSON.stringify(key)}. ` +
        `Run \`groundflare secret set ${key} <token>\` first.`,
      'prerequisite',
      STAGE_ID,
    )
  }
  return token
}
