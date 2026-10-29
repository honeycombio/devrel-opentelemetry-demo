// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using System.Data.Common;
using System.Diagnostics;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Accounting;

/// <summary>
/// Appends the current trace context to every EF Core query as a SQLCommenter
/// comment, e.g. <c>/*traceparent='00-&lt;trace_id&gt;-&lt;span_id&gt;-01'*/</c>.
/// Postgres logs the comment with the statement, which lets the collector tie
/// Postgres logs to the trace. Npgsql starts its own query span only after
/// this runs, so the span ID is the calling span's, not the query span's.
/// EF Core runs all queries and SaveChanges through ExecuteReader.
/// </summary>
public sealed class SqlCommenterInterceptor : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        AppendTraceparent(command);
        return result;
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        AppendTraceparent(command);
        return new ValueTask<InterceptionResult<DbDataReader>>(result);
    }

    private static void AppendTraceparent(DbCommand command)
    {
        // Activity.Id is the W3C traceparent ("00-<trace_id>-<span_id>-<flags>") when the ID format is W3C.
        if (Activity.Current is { IdFormat: ActivityIdFormat.W3C, Id: { } traceparent })
        {
            command.CommandText += $" /*traceparent='{traceparent}'*/";
        }
    }
}
