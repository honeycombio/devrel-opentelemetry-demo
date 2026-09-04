# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

defmodule FlagdUi.FlagMetric do
  @moduledoc """
  Emits the current numeric value of a feature flag as an OTLP gauge metric,
  separate from any trace/span data. This is deliberately NOT attached to
  request spans: a flag like paymentFailure is a chaos-engineering dial, and
  putting its value on the traces it influences would surface things like
  "payment decline set to 75%" in BubbleUp on the very traces it breaks.
  Sending it as its own metric lets you graph "what was this flag set to
  over time" without polluting trace analysis.
  """

  require Logger

  @metric_name "feature_flag.value"
  @scope_name "flagd_ui.feature_flags"

  @doc """
  Fire-and-forget: posts a gauge data point for `flag_name` = `value` to the
  collector's OTLP/HTTP endpoint. `value` must be numeric (int or float); any
  other variant value (e.g. a non-numeric variant) is silently skipped since
  there's nothing to graph.
  """
  def emit(flag_name, variant_name, value) when is_number(value) do
    Task.start(fn -> post(flag_name, variant_name, value) end)
    :ok
  end

  def emit(_flag_name, _variant_name, _value), do: :ok

  defp post(flag_name, variant_name, value) do
    endpoint = System.get_env("OTEL_EXPORTER_OTLP_ENDPOINT")

    if endpoint do
      body = payload(flag_name, variant_name, value)

      Req.post(endpoint <> "/v1/metrics",
        json: body,
        headers: [{"content-type", "application/json"}]
      )
    end
  rescue
    error ->
      Logger.warning("Failed to emit feature flag metric: #{inspect(error)}")
  end

  defp payload(flag_name, variant_name, value) do
    %{
      "resourceMetrics" => [
        %{
          "resource" => %{
            "attributes" => [
              string_attr("service.name", System.get_env("OTEL_SERVICE_NAME") || "flagd-ui")
            ]
          },
          "scopeMetrics" => [
            %{
              "scope" => %{"name" => @scope_name},
              "metrics" => [
                %{
                  "name" => @metric_name,
                  "unit" => "1",
                  "gauge" => %{
                    "dataPoints" => [
                      %{
                        "asDouble" => value * 1.0,
                        "timeUnixNano" => Integer.to_string(System.system_time(:nanosecond)),
                        "attributes" => [
                          string_attr("feature_flag.key", flag_name),
                          string_attr("feature_flag.variant", variant_name)
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    }
  end

  defp string_attr(key, value) do
    %{"key" => key, "value" => %{"stringValue" => value}}
  end
end
