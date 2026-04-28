# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

defmodule FlagdUi.Storage do
  @moduledoc """
  Storage module. This module initializes a process as a separate GenServer
  to linearize reads and writes preventing conflicts and last-writer-wins.
  """

  use GenServer
  require Logger

  @file_path Application.compile_env!(:flagd_ui, :storage_file_path)

  def start_link(opts) do
    name = Keyword.get(opts, :name, Storage)

    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @impl true
  def init(_) do
    state = @file_path |> File.read!() |> Jason.decode!()
    Logger.info("Read new state from file")

    {:ok, state}
  end

  @impl true
  def handle_call(:read, _from, state) do
    {:reply, state, state}
  end

  @impl true
  def handle_cast({:replace, json_string}, state) do
    new_state = Jason.decode!(json_string)

    emit_diff_change_events(state, new_state, "ui-advanced")

    write_state(json_string)

    {:noreply, new_state}
  end

  @impl true
  def handle_cast({:write, flag_name, flag_value}, state) do
    previous_variant = get_in(state, ["flags", flag_name, "defaultVariant"]) || ""

    emit_change_event(flag_name, previous_variant, flag_value, "ui-dashboard")

    new_state =
      Map.update(state, "flags", %{}, fn flags ->
        update_flag(flags, flag_name, flag_value)
      end)

    json_state = Jason.encode!(new_state, pretty: true)

    write_state(json_state)

    {:noreply, new_state}
  end

  defp update_flag(flags, flag_name, value) do
    flags
    |> Enum.map(fn
      {flag, data} when flag == flag_name -> {flag, Map.replace(data, "defaultVariant", value)}
      {flag, data} -> {flag, data}
    end)
    |> Map.new()
  end

  defp write_state(json_string) do
    File.write!(@file_path, json_string)

    Logger.info("Wrote new state to file")
  end

  # Diff old vs new flag state and emit one event per flag whose defaultVariant
  # actually changed. Newly-added flags are emitted with previous_variant="";
  # removed flags are emitted with variant="". Flags whose variant is unchanged
  # produce no event.
  defp emit_diff_change_events(old_state, new_state, source) do
    old_flags = Map.get(old_state, "flags", %{})
    new_flags = Map.get(new_state, "flags", %{})

    keys = MapSet.union(MapSet.new(Map.keys(old_flags)), MapSet.new(Map.keys(new_flags)))

    Enum.each(keys, fn flag_name ->
      old_variant = get_in(old_flags, [flag_name, "defaultVariant"]) || ""
      new_variant = get_in(new_flags, [flag_name, "defaultVariant"]) || ""

      if old_variant != new_variant do
        emit_change_event(flag_name, old_variant, new_variant, source)
      end
    end)
  end

  # Plain Logger.info — flagd-ui's stdout is scraped by the cluster's filelog
  # receiver. The collector's logs/markers pipeline matches on the
  # "Flag changed:" prefix, copies the relevant slice of body into a
  # marker.message attribute, and ships it via honeycombmarker.
  defp emit_change_event(flag_name, previous_variant, new_variant, source) do
    Logger.info(
      "Flag changed: #{flag_name} (#{previous_variant} → #{new_variant}) [#{source}]"
    )
  end
end
