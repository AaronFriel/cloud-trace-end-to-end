# Cloud Trace End to End Policy

The following classes implement a trace policy based on the built-in trace
* policy with a few distinctions.

The built-in trace policy applies four filters (predicates) in sequence, each
of which takes its arguments from the trace options defined below:

 1. The sampler filter, which implements the "samplingRate" option and
    ensures traces do not exceed a given volume (because they cost $ to
    store)
 2. The URL filter, which implements the "ignoreUrl" option and filters out
    certain URLs such as health check URLs.
 3. The method filter, which implements the "ignoreMethods" option and
    filters out certain request methods.
 4. The context header filter, which implements the "contextHeaderBehavior"
    option, for more details see:
    https://github.com/googleapis/cloud-trace-nodejs/blob/ac7e886c178ca9c34502e9baa9eb190d23104347/src/config.ts#L209-L222

However, since we're supplying our own "shouldTrace" function, we need to
know what we want to implement. These will be referenced later as the
Requirements.

 1. We do want to filter on the URLs, because we want to filter out liveness
    and readiness probes.
 2. We want to ignore the contextHeaderBehavior and apply a special policy
    called 'end-to-end':
    * If we are in a traced span (the "options" flag on the trace header is
      on-zero), then return true unconditionally.
    * If we are in an untraced span (options flag is 0) or not in a trace at
      all we apply the rules below.
 3. We want sampling, so that we can put a soft cap on our costs, but we have
    to bring your own sampler (BYOS).

Reference to built-in trace policy:
https://github.com/googleapis/cloud-trace-nodejs/blob/ac7e886c178ca9c34502e9baa9eb190d23104347/src/tracing-policy.ts#L142-L146