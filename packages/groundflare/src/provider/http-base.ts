/**
 * Shared HTTP transport for Provider implementations.
 *
 * Every cloud-provider REST client we've written so far has the same
 * shape: a bearer token, a base URL, `fetch` + AbortController + JSON
 * parse, error translation to `ProviderError`. Subclasses differ in:
 *
 *   - The brand string used in error messages ("Hetzner", "DigitalOcean"…)
 *   - How a failed response body encodes its error code/message
 *     (Hetzner: `body.error.{code, message}`; DO: `body.{id, message}`)
 *   - The high-level methods themselves (endpoint paths, request/response
 *     translation), which stay on the subclass.
 *
 * HttpProvider owns the transport + retry rule; subclasses implement
 * `parseError()` and supply a `brand` via super().
 */

import { ProviderError } from './types.js'

export interface HttpProviderOptions {
  readonly token: string
  /** Override base URL (tests only — no production reason to set this). */
  readonly baseUrl?: string
  /** Inject a fetch implementation; defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch
  /** Per-request timeout in milliseconds. Default 30s. */
  readonly timeoutMs?: number
}

export interface HttpProviderConfig {
  /** Brand used in error messages. */
  readonly brand: string
  /** Default base URL used when opts.baseUrl is not provided. */
  readonly defaultBaseUrl: string
}

const DEFAULT_TIMEOUT_MS = 30_000

export abstract class HttpProvider {
  protected readonly token: string
  protected readonly baseUrl: string
  protected readonly fetchImpl: typeof fetch
  protected readonly timeoutMs: number
  protected readonly brand: string

  constructor(opts: HttpProviderOptions, config: HttpProviderConfig) {
    if (!opts.token || opts.token.length === 0) {
      throw new TypeError(`${this.constructor.name}: token is required`)
    }
    this.token = opts.token
    this.baseUrl = opts.baseUrl ?? config.defaultBaseUrl
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.brand = config.brand
  }

  /**
   * Translate a failed response body into {code, message}. Each provider
   * has its own error envelope shape, so this is the one knob subclasses
   * must turn. Called with the parsed JSON body (or undefined when the
   * response had no body).
   */
  protected abstract parseError(body: unknown): {
    code: string
    message: string
  }

  protected async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    }
    let bodyText: string | undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      bodyText = JSON.stringify(body)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError(
          `${this.brand} ${method} ${path} timed out after ${this.timeoutMs}ms`,
          'timeout',
          undefined,
          true,
          { cause: err },
        )
      }
      throw new ProviderError(
        `${this.brand} ${method} ${path}: network error`,
        'network',
        undefined,
        true,
        { cause: err },
      )
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 204) {
      return undefined as T
    }

    const text = await response.text()
    let json: unknown
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch (err) {
        throw new ProviderError(
          `${this.brand} ${method} ${path}: malformed response body`,
          'bad_response',
          response.status,
          false,
          { cause: err },
        )
      }
    }

    if (response.status >= 200 && response.status < 300) {
      return json as T
    }

    const { code, message } = this.parseError(json)
    throw new ProviderError(
      `${this.brand} ${method} ${path}: ${response.status} ${code} — ${message}`,
      code,
      response.status,
      isRetryableStatus(response.status),
    )
  }
}

/**
 * 5xx and 429 are retryable; other 4xx signal the caller needs to fix
 * the request. Shared rule, not provider-specific.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}
