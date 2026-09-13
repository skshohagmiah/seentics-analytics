function parseBool(v: string | undefined, defaultTrue: boolean): boolean {
  if (v == null || v === "") return defaultTrue;
  const x = v.toLowerCase();
  if (x === "0" || x === "false" || x === "no") return false;
  if (x === "1" || x === "true" || x === "yes") return true;
  return defaultTrue;
}

function parseIntEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const KNOWN_INSECURE_SECRETS = new Set([
  "your-super-secret-jwt-key--must-be-32-characters",
  "your-super-secret-jwt-key-change-this-in-production",
  "your-refresh-secret-key-here-make-it-different-from-jwt-secret",
  "dev-global-api-key",
  "your-global-api-key-for-service-communication",
]);

function requireProductionSecret(name: string, value: string): void {
  if (value.length < 32 || KNOWN_INSECURE_SECRETS.has(value)) {
    throw new Error(`${name} must be a unique value of at least 32 characters in production`);
  }
}

function requireHttpsUrl(name: string, value: string): void {
  try {
    if (new URL(value).protocol === "https:") return;
  } catch {
    // Give the same actionable error for a malformed URL.
  }
  throw new Error(`${name} must be an https URL in production`);
}

export type AppConfig = ReturnType<typeof env>;

export function env() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const jwtSecret = process.env.JWT_SECRET ?? "";
  const globalApiKey = process.env.GLOBAL_API_KEY ?? "";
  const environment = (process.env.ENVIRONMENT ?? process.env.NODE_ENV ?? "development").trim().toLowerCase();
  const isProduction = environment === "production";

  const bucket = process.env.S3_BUCKET_REPLAYS ?? process.env.S3_BUCKET ?? "seentics-replays";
  /**
   * Heatmap screenshots and layout snapshots. Defaults to the replay bucket, so a
   * single-bucket deployment keeps working untouched; set `S3_BUCKET_HEATMAPS` to split
   * them. Empty falls back rather than addressing a bucket named "" — compose passes
   * the variable through with an empty default.
   */
  const heatmapBucket = (process.env.S3_BUCKET_HEATMAPS ?? "").trim() || bucket;
  const region = process.env.S3_REGION ?? process.env.AWS_REGION ?? "auto";
  const endpoint = process.env.S3_ENDPOINT;
  /** Host used only in presigned GET URLs (browser must resolve it). When unset, `endpoint` is used. */
  const s3PublicEndpoint = (process.env.S3_PUBLIC_ENDPOINT ?? "").trim() || undefined;
  const accessKey = process.env.S3_ACCESS_KEY ?? process.env.AWS_ACCESS_KEY_ID ?? "";
  const secretKey = process.env.S3_SECRET_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "";

  /**
   * Presigned GET lifetime, in seconds.
   *
   * Both names are accepted for compatibility, but neither shadows the other: setting
   * `REPLAY_PRESIGN_TTL_SECONDS` used to be silently ignored whenever
   * `HEATMAP_PRESIGN_TTL_SECONDS` was also set, because the first `??` won.
   */
  const presignTtlSec = parseIntEnv(
    process.env.REPLAY_PRESIGN_TTL_SECONDS ?? process.env.HEATMAP_PRESIGN_TTL_SECONDS,
    3600,
  );
  /**
   * How long a session with an empty spool buffer is kept before it is dropped.
   *
   * Kept (not dropped) rather than purged eagerly so `nextChunkSeq` survives between
   * flush windows — see the note at the end of `SessionChunkBuffer.doFlushChunk`. The spool
   * floors this at the flush window for the same reason. It defaults high because the
   * cost of holding an idle entry is one small object, and the cost of dropping one too
   * early is a cold S3 listing that can overwrite chunk 0.
   */
  const spoolIdleMs = parseIntEnv(process.env.REPLAY_SPOOL_IDLE_MS, 45 * 60 * 1000);
  // 30s, not 10s. The flush window sets how many immutable S3 objects a recording
// becomes: at 10s a one-hour session produced ~360 chunks, and the playback endpoint
// presigns every one of them, so the player issued ~360 GETs. 30s cuts that 3x. The
// cost is the loss window — the spool is in-memory, so an unclean exit loses up to
// this much of a live session, which is an easy trade for replay.
const replayChunkFlushMs = parseIntEnv(process.env.REPLAY_CHUNK_FLUSH_MS, 30_000);

  const configuredCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "").trim();
  const corsAllowedOrigins = configuredCorsOrigins ||
    "http://localhost:3000,http://127.0.0.1:3000,https://www.seentics.com,https://seentics.com";

  if (isProduction) {
    requireProductionSecret("JWT_SECRET", jwtSecret);
    requireProductionSecret("GLOBAL_API_KEY", globalApiKey);
    if (!configuredCorsOrigins || configuredCorsOrigins === "*") {
      throw new Error("CORS_ALLOWED_ORIGINS must list explicit dashboard origins in production");
    }
    if (!endpoint || !accessKey || !secretKey) {
      throw new Error("S3_ENDPOINT, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY are required in production");
    }
    if (!s3PublicEndpoint) {
      throw new Error("S3_PUBLIC_ENDPOINT is required in production so replay and heatmap URLs reach browsers");
    }
    requireHttpsUrl("S3_PUBLIC_ENDPOINT", s3PublicEndpoint);
  }

  const rateLimitEnabled = parseBool(process.env.RATE_LIMIT_ENABLED, true);
  const rateWindowMs = parseIntEnv(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
  const rateGeneral = parseIntEnv(process.env.RATE_LIMIT_GENERAL_MAX, isProduction ? 300 : 2000);
  const rateAuth = parseIntEnv(process.env.RATE_LIMIT_AUTH_MAX, 20);
  const rateTracker = parseIntEnv(
    process.env.RATE_LIMIT_TRACKER_MAX,
    isProduction ? 120 : 50_000,
  );
  const rateInternal = parseIntEnv(process.env.RATE_LIMIT_INTERNAL_MAX, 2000);
  const rateRaw = parseIntEnv(
    process.env.RATE_LIMIT_RAW_MAX,
    isProduction ? 240 : 4000,
  );
  const rateRawPerKey = parseIntEnv(
    process.env.RATE_LIMIT_RAW_PER_KEY_MAX,
    isProduction ? 120 : 8000,
  );

  /** Off in development by default so dashboards don’t stick on cached empty responses; enable in prod or set ANALYTICS_CACHE_ENABLED=true. */
  const analyticsCacheEnabled = parseBool(process.env.ANALYTICS_CACHE_ENABLED, isProduction);
  const analyticsCacheTtlMs = parseIntEnv(process.env.ANALYTICS_CACHE_TTL_MS, 45_000);
  const analyticsCacheMaxEntries = parseIntEnv(process.env.ANALYTICS_CACHE_MAX_ENTRIES, 512);

  const ingestQueueFlushMs = parseIntEnv(process.env.INGEST_QUEUE_FLUSH_MS, 1000);
  const ingestQueueMaxEvents = parseIntEnv(process.env.INGEST_QUEUE_MAX_EVENTS_BEFORE_FLUSH, 50_000);
  const ingestQueueMaxRecordings = parseIntEnv(process.env.INGEST_QUEUE_MAX_RECORDINGS_BEFORE_FLUSH, 50_000);
  const ingestQueueMaxHeatmaps = parseIntEnv(process.env.INGEST_QUEUE_MAX_HEATMAPS_BEFORE_FLUSH, 25_000);
  const ingestQueueMaxFunnels = parseIntEnv(process.env.INGEST_QUEUE_MAX_FUNNELS_BEFORE_FLUSH, 50_000);
  const ingestQueueMaxAutomations = parseIntEnv(process.env.INGEST_QUEUE_MAX_AUTOMATIONS_BEFORE_FLUSH, 50_000);
  const ingestQueueMaxProfiles = parseIntEnv(process.env.INGEST_QUEUE_MAX_PROFILES_BEFORE_FLUSH, 20_000);
  // Bytes, not events: a heatmap screenshot is up to 3.5MB and a DOM snapshot 1.5MB, so a
  // count cap cannot bound this buffer's memory. See `DEFAULT_MAX_HEATMAP_BYTES`.
  const ingestQueueMaxHeatmapBytes = parseIntEnv(
    process.env.INGEST_QUEUE_MAX_HEATMAP_BYTES,
    64 * 1024 * 1024,
  );

  const trackerCacheEnabled = parseBool(process.env.TRACKER_CACHE_ENABLED, true);
  const trackerWebsiteCacheTtlMs = parseIntEnv(process.env.TRACKER_WEBSITE_CACHE_TTL_MS, 180_000);
  const trackerOriginCacheTtlMs = parseIntEnv(process.env.TRACKER_ORIGIN_CACHE_TTL_MS, 180_000);
  const trackerCacheMaxEntries = parseIntEnv(process.env.TRACKER_CACHE_MAX_ENTRIES, 4096);

  const screenshotCacheEnabled = parseBool(process.env.SCREENSHOT_CACHE_ENABLED, true);
  const screenshotCacheTtlMs = parseIntEnv(process.env.SCREENSHOT_CACHE_TTL_MS, 60 * 60 * 1000); // 1 hour (60 minutes)
  const screenshotCacheMaxEntries = parseIntEnv(process.env.SCREENSHOT_CACHE_MAX_ENTRIES, 1000);

  const dataRetentionEnabled = parseBool(process.env.DATA_RETENTION_ENABLED, true);
  const dataRetentionCron = process.env.DATA_RETENTION_CRON ?? "15 4 * * *";
  const dataRetentionAnalyticsDays = parseIntEnv(process.env.DATA_RETENTION_ANALYTICS_DAYS, 1095);
  const dataRetentionReplayDays = parseIntEnv(process.env.DATA_RETENTION_REPLAY_DAYS, 30);
  const dataRetentionHeatmapDays = parseIntEnv(process.env.DATA_RETENTION_HEATMAP_DAYS, 7);
  const dataRetentionFunnelAutomationDays = parseIntEnv(
    process.env.DATA_RETENTION_FUNNEL_AUTOMATION_DAYS,
    30,
  );
  const dataRetentionTempHours = parseIntEnv(process.env.DATA_RETENTION_TEMP_HOURS, 24);
  const dataRetentionReplayBatch = parseIntEnv(process.env.DATA_RETENTION_REPLAY_DELETE_BATCH, 500);
  const dataRetentionEnterpriseEnabled = parseBool(process.env.DATA_RETENTION_ENTERPRISE_ENABLED, false);
  const enterpriseRetentionUrlRaw = process.env.ENTERPRISE_RETENTION_URL ?? "";
  const enterpriseGatewayUrl = (process.env.ENTERPRISE_GATEWAY_URL ?? "").replace(/\/$/, "");
  const enterpriseRetentionUrl =
    enterpriseRetentionUrlRaw ||
    (enterpriseGatewayUrl ? `${enterpriseGatewayUrl}/api/v1/internal/data-retention` : "");
  const dataRetentionEnterpriseFetchMs = parseIntEnv(process.env.DATA_RETENTION_ENTERPRISE_FETCH_MS, 15_000);

  const logLevel = (process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug")).toLowerCase();
  /** When true, emit structured `tracker_collect` / ingest summaries at `info` (see also `LOG_LEVEL=debug`). */
  const diagnosticLog = parseBool(process.env.SEENTICS_DIAGNOSTIC_LOG, false);
  /** Requests that exceed this duration emit an additional slow_request warn log. 0 disables. */
  const slowRequestThresholdMs = parseIntEnv(process.env.SLOW_REQUEST_THRESHOLD_MS, 500);

  const maxmindDbPath = (process.env.MAXMIND_DB_PATH ?? "").trim();
  const maxmindGeoCacheMax = parseIntEnv(process.env.MAXMIND_GEO_CACHE_MAX, 50_000);

  return {
    databaseUrl,
    jwtSecret,
    globalApiKey,
    environment,
    isProduction,
    s3: { bucket, heatmapBucket, region, endpoint, publicEndpoint: s3PublicEndpoint, accessKey, secretKey },
    presignTtlMs: Math.max(60, presignTtlSec) * 1000,
    spoolIdleMs,
    replayChunkFlushMs: Math.max(5_000, replayChunkFlushMs),
    port: Number(process.env.PORT ?? "8080"),
    trustProxy: parseBool(process.env.TRUST_PROXY, false),
    /** Local GeoLite2-City / GeoIP2-City `.mmdb` path; no HTTP API — see `lib/maxmind-geo.ts`. */
    maxmind: {
      dbPath: maxmindDbPath,
      geoCacheMax: Math.max(1000, maxmindGeoCacheMax),
    },
    corsAllowedOrigins,
    logLevel,
    diagnosticLog,
    slowRequestThresholdMs,
    rateLimit: {
      enabled: rateLimitEnabled,
      windowMs: rateWindowMs,
      generalMax: rateGeneral,
      authMax: rateAuth,
      trackerMax: rateTracker,
      internalMax: rateInternal,
      /** Per client IP for `GET /api/v1/raw/*` (before API key is validated). */
      rawMax: rateRaw,
      /** Per verified `api_keys` row for `/api/v1/raw/*` (after successful `X-API-Key` check). */
      rawPerKeyMax: rateRawPerKey,
    },
    analyticsCache: {
      enabled: analyticsCacheEnabled,
      ttlMs: analyticsCacheTtlMs,
      maxEntries: analyticsCacheMaxEntries,
    },
    ingestQueue: {
      flushMs: Math.max(200, ingestQueueFlushMs),
      maxEventsBeforeForceFlush: Math.max(1000, ingestQueueMaxEvents),
      maxRecordingsBeforeForceFlush: Math.max(1000, ingestQueueMaxRecordings),
      maxHeatmapsBeforeForceFlush: Math.max(500, ingestQueueMaxHeatmaps),
      maxFunnelsBeforeForceFlush: Math.max(1000, ingestQueueMaxFunnels),
      maxAutomationsBeforeForceFlush: Math.max(1000, ingestQueueMaxAutomations),
      maxProfilesBeforeForceFlush: Math.max(500, ingestQueueMaxProfiles),
      maxHeatmapBytes: Math.max(8 * 1024 * 1024, ingestQueueMaxHeatmapBytes),
    },
    /** In-memory TTL caches for tracker hot paths (`resolveWebsiteForTracker`, `validateOriginDomain`). */
    trackerCache: {
      enabled: trackerCacheEnabled,
      websiteTtlMs: Math.max(10_000, trackerWebsiteCacheTtlMs),
      originTtlMs: Math.max(10_000, trackerOriginCacheTtlMs),
      maxEntries: Math.max(64, trackerCacheMaxEntries),
    },
    /** In-memory cache for heatmap screenshot lookups (avoid redundant DB queries). */
    screenshotCache: {
      enabled: screenshotCacheEnabled,
      ttlMs: Math.max(10_000, screenshotCacheTtlMs),
      maxEntries: Math.max(10, screenshotCacheMaxEntries),
    },
    dataRetention: {
      enabled: dataRetentionEnabled,
      cronExpression: dataRetentionCron,
      analyticsDays: Math.max(1, dataRetentionAnalyticsDays),
      replayDays: Math.max(1, dataRetentionReplayDays),
      heatmapDays: Math.max(1, dataRetentionHeatmapDays),
      funnelAutomationDays: Math.max(1, dataRetentionFunnelAutomationDays),
      tempDataHours: Math.max(1, dataRetentionTempHours),
      replayDeleteBatchSize: Math.max(10, dataRetentionReplayBatch),
      enterpriseEnabled: dataRetentionEnterpriseEnabled,
      enterpriseRetentionUrl: enterpriseRetentionUrl || undefined,
      enterpriseFetchTimeoutMs: Math.max(3000, dataRetentionEnterpriseFetchMs),
    },
  };
}
