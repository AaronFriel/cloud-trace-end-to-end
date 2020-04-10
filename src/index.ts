import {
  TracePolicy,
  RequestDetails,
} from '@google-cloud/trace-agent/build/src/config';
import {
  BuiltinTracePolicy,
  TraceContextHeaderBehavior,
} from '@google-cloud/trace-agent/build/src/tracing-policy';
import { SpanOptions } from '@google-cloud/trace-agent/build/src/plugin-types';

/**
 * The following classes implement a trace policy based on the built-in trace
 * policy with a few distinctions.
 *
 * The built-in trace policy applies four filters (predicates) in sequence, each
 * of which takes its arguments from the trace options defined below:
 *
 *  1. The sampler filter, which implements the "samplingRate" option and
 *     ensures traces do not exceed a given volume (because they cost $ to
 *     store)
 *  2. The URL filter, which implements the "ignoreUrl" option and filters out
 *     certain URLs such as health check URLs.
 *  3. The method filter, which implements the "ignoreMethods" option and
 *     filters out certain request methods.
 *  4. The context header filter, which implements the "contextHeaderBehavior"
 *     option, for more details see:
 *     https://github.com/googleapis/cloud-trace-nodejs/blob/ac7e886c178ca9c34502e9baa9eb190d23104347/src/config.ts#L209-L222
 *
 * However, since we're supplying our own "shouldTrace" function, we need to
 * know what we want to implement. These will be referenced later as the
 * Requirements.
 *
 *  1. We do want to filter on the URLs, because we want to filter out liveness
 *     and readiness probes.
 *  2. We want to ignore the contextHeaderBehavior and apply a special policy
 *     called 'end-to-end':
 *     * If we are in a traced span (the "options" flag on the trace header is
 *       on-zero), then return true unconditionally.
 *     * If we are in an untraced span (options flag is 0) or not in a trace at
 *       all we apply the rules below.
 *  3. We want sampling, so that we can put a soft cap on our costs, but we have
 *     to bring your own sampler (BYOS).
 *
 * Reference to built-in trace policy:
 * https://github.com/googleapis/cloud-trace-nodejs/blob/ac7e886c178ca9c34502e9baa9eb190d23104347/src/tracing-policy.ts#L142-L146
 */

interface TracePolicyPredicate<T> {
  shouldTrace(value: T): boolean;
}

/**
 * Given a sampling rate in samples-per-second, return true once per that
 * interval.
 */
class Sampler implements TracePolicyPredicate<number> {
  private readonly traceWindow: number;
  private nextTraceStart: number;

  constructor(
    samplesPerSecondInput: number,
    nextTraceStart: number = Date.now(),
  ) {
    let samplesPerSecond = samplesPerSecondInput;
    // Do not allow more than 1000 samples per second
    if (samplesPerSecond > 1000) {
      samplesPerSecond = 1000;
    }
    this.traceWindow = 1000 / samplesPerSecond;
    this.nextTraceStart = nextTraceStart;
  }

  public shouldTrace(dateMillis: number): boolean {
    if (dateMillis < this.nextTraceStart) {
      return false;
    }
    this.nextTraceStart = dateMillis + this.traceWindow;

    return true;
  }
}

/**
 * Creates a sampler per unique "name" of trace seen, ensuring that we trace one
 * sample per unique endpoint per rate.
 *
 * This mitigates the possibility that a single trace dominates all others. Say
 * we have one cronjob that runs once per second, and one cronjob that runs once
 * per hour. It's exceedingly unlikely the "once per hour" cronjob would ever be
 * traced if we collect only one trace per hour - it would have to be the very
 * first thing traced.
 */
class MultiSampler implements TracePolicy {
  private readonly samplers: Record<string, Sampler>;
  private readonly samplesPerSecond: number;
  private readonly unnamedSampler: Sampler;
  private readonly samplerStart: number;

  constructor(samplesPerSecondInput: number) {
    let samplesPerSecond = samplesPerSecondInput;
    // Do not allow more than 1000 samples per second
    if (samplesPerSecond > 1000) {
      samplesPerSecond = 1000;
    }
    this.samplesPerSecond = samplesPerSecond;
    this.samplers = {};
    this.unnamedSampler = new Sampler(samplesPerSecond);
    this.samplerStart = new Date().getTime();
  }

  public shouldTrace({
    options,
    timestamp,
  }: RequestDetails & { options: Partial<SpanOptions> }): boolean {
    const sampler: Sampler | undefined = this.getSampler(options?.name);

    return sampler.shouldTrace(timestamp);
  }

  private getSampler(name?: string) {
    if (!name) {
      return this.unnamedSampler;
    }

    let sampler: Sampler | undefined = this.samplers[name];
    if (!sampler) {
      this.samplers[name] = sampler = new Sampler(
        this.samplesPerSecond,
        this.samplerStart,
      );
    }

    return sampler;
  }
}

export class EndToEndTracePolicy implements TracePolicy {
  /**
   * Implements the URL and method filters for us.
   */
  private readonly builtinTracePolicy: TracePolicy;
  /**
   * Implements the sample rate requirement.
   */
  private readonly sampler: TracePolicy;

  constructor(config: {
    ignoreMethods: string[];
    ignoreUrls: string[];
    samplingRate: number;
  }) {
    this.builtinTracePolicy = new BuiltinTracePolicy({
      ignoreMethods: config.ignoreMethods,
      ignoreUrls: config.ignoreUrls,
      // our code will handle trace header, requirement 2
      contextHeaderBehavior: TraceContextHeaderBehavior.IGNORE,
      // our code will handle sampling, requirement 3
      samplingRate: 0,
    });

    // If the sampling rate is 0 or negative, use a fixed sample function.
    if (config.samplingRate === 0) {
      this.sampler = { shouldTrace: () => true };
    } else if (config.samplingRate < 0) {
      this.sampler = { shouldTrace: () => false };
    } else {
      this.sampler = new MultiSampler(config.samplingRate);
    }

    this.sampler = new MultiSampler(config.samplingRate);
  }

  public shouldTrace(details: RequestDetails): boolean {
    // Implement requirement 1: URL and method filters.
    if (!this.builtinTracePolicy.shouldTrace(details)) {
      return false;
    }

    // Implement requirement 2: If we are in a trace, short circuit true
    if (details.traceContext?.options) {
      return true;
    }

    // Implement requirement 3: Sample the trace:
    return this.sampler.shouldTrace(details);
  }
}
