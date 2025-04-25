using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using OpenFeature;
using OpenFeature.Model;
using OpenTelemetry.Trace;

namespace cartservice;

public class DemoTracingHook : Hook
{
    public override ValueTask AfterAsync<T>(HookContext<T> context, FlagEvaluationDetails<T> details, IReadOnlyDictionary<string, object> hints = null, CancellationToken cancellationToken = default(CancellationToken))
    {
        Activity current = Activity.Current;
        current?.SetTag("feature_flag.key", details.FlagKey)
                .SetTag("feature_flag.variant", details.Variant)
                .SetTag("feature_flag.provider_name", context.ProviderMetadata.Name)
                .SetTag("feature_flag.value", details.Value);

        return default;
    }

    public override ValueTask ErrorAsync<T>(HookContext<T> context, Exception error, IReadOnlyDictionary<string, object> hints = null, CancellationToken cancellationToken = default(CancellationToken))
    {
        Activity.Current?.RecordException(error);
        return default;
    }
}