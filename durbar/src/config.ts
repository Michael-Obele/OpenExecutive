/**
 * Configuration, read once at startup from the environment.
 *
 * Provider selection is explicit rather than inferred. The reference
 * implementation shipped an Anthropic-native design and later bolted a second
 * provider onto it under the name `LOCAL_MODELS_*` — which then became the path
 * that served DeepSeek over the network. The code was fine; the name lied, and
 * the lie cost real time to unpick. Vendors are named for what they are here.
 */

export type ProviderName = 'deepseek' | 'openrouter' | 'compat';

export interface ProviderConfig {
  readonly name: ProviderName;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningModel: string;
  readonly routingModel: string;
  /** Extra headers a vendor needs on every request (e.g. OpenRouter's attribution). */
  readonly headers: Readonly<Record<string, string>>;
}

export interface Settings {
  readonly dbPath: string;
  readonly port: number;
  /**
   * Absolute URL the dashboard should call for server work. Empty means
   * same-origin, which is the local/Docker case. Setting it is the only
   * difference between "everything in one container" and "frontend on Netlify,
   * backend on Fly" — the same build serves both.
   */
  readonly publicServerUrl: string;
  /**
   * Origins permitted to call this server cross-origin. Empty means
   * same-origin only, which is the local/Docker case. Set it when the dashboard
   * is hosted separately (Netlify/Vercel) from the server (Fly/Render).
   */
  readonly allowedOrigins: readonly string[];
  /**
   * UTC time (HH:MM) the daily brief is delivered. Upstream calls this
   * PRINCIPAL_BRIEF_MORNING_TIME and defaults to 08:00.
   */
  readonly morningBriefTime: string;
  readonly eodDigestTime: string;
  readonly reflectionTime: string;
  readonly provider: ProviderConfig;
  /**
   * Token required to cancel scheduled actions from non-loopback hosts.
   * When set, DELETE /scheduled/{id} requires X-Admin-Token. When unset,
   * loopback is allowed and remote is 503 — mirrors the Python
   * `require_admin_token` dependency in `api/routes/scheduled.py`.
   */
  readonly scheduledAdminToken: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function providerFrom(name: ProviderName): ProviderConfig {
  switch (name) {
    case 'deepseek':
      return {
        name,
        baseUrl: optional('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
        apiKey: required('DEEPSEEK_API_KEY'),
        model: optional('DURBAR_MODEL', 'deepseek-chat'),
        reasoningModel: optional('DURBAR_REASONING_MODEL', 'deepseek-reasoner'),
        routingModel: optional('DURBAR_ROUTING_MODEL', 'deepseek-chat'),
        headers: {},
      };

    case 'openrouter':
      return {
        name,
        baseUrl: optional('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
        apiKey: required('OPENROUTER_API_KEY'),
        model: optional('DURBAR_MODEL', 'deepseek/deepseek-chat'),
        reasoningModel: optional(
          'DURBAR_REASONING_MODEL',
          'deepseek/deepseek-r1',
        ),
        routingModel: optional('DURBAR_ROUTING_MODEL', 'deepseek/deepseek-chat'),
        // OpenRouter attributes traffic by these; they are optional but polite.
        headers: {
          'HTTP-Referer': optional('OPENROUTER_REFERER', 'https://durbar.local'),
          'X-Title': optional('OPENROUTER_TITLE', 'Durbar'),
        },
      };

    case 'compat':
      // Any OpenAI-compatible endpoint: a gateway, a proxy, a vendor with a
      // different name for the same wire protocol.
      return {
        name,
        baseUrl: required('DURBAR_BASE_URL'),
        apiKey: required('DURBAR_API_KEY'),
        model: required('DURBAR_MODEL'),
        reasoningModel: optional('DURBAR_REASONING_MODEL', required('DURBAR_MODEL')),
        routingModel: optional('DURBAR_ROUTING_MODEL', required('DURBAR_MODEL')),
        headers: {},
      };
  }
}

export function loadSettings(): Settings {
  const raw = optional('DURBAR_PROVIDER', 'deepseek');
  if (raw !== 'deepseek' && raw !== 'openrouter' && raw !== 'compat') {
    throw new Error(
      `DURBAR_PROVIDER must be deepseek, openrouter or compat (got "${raw}")`,
    );
  }

  return {
    dbPath: optional('DURBAR_DB_PATH', './durbar.db'),
    port: Number(optional('DURBAR_PORT', '8787')),
    publicServerUrl: optional('DURBAR_PUBLIC_URL', ''),
    allowedOrigins: optional('DURBAR_ALLOWED_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    morningBriefTime: optional('PRINCIPAL_BRIEF_MORNING_TIME', '08:00'),
    eodDigestTime: optional('PRINCIPAL_BRIEF_EOD_TIME', '18:00'),
    reflectionTime: optional('PRINCIPAL_REFLECTION_TIME', '07:30'),
    provider: providerFrom(raw),
    scheduledAdminToken: optional('SCHEDULED_ADMIN_TOKEN', ''),
  };
}
