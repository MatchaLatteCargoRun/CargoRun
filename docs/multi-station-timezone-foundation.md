# Multi-station timezone foundation

`CargoRunStations.TimeZoneId` is the authoritative IANA timezone for an operational station. `OperatingDate` is the station-local service date. Absolute operational events remain UTC instants, and browser timezone settings never establish station ownership or service date.

The current MACH/FOW schema has only `IncomingMachMessages.EventLocalDateTime` (`datetime2`) for `StsTime`. That type cannot retain an offset, the source timezone, and a separately derived UTC instant. Phase 2B therefore preserves the source wall-clock digits in `EventLocalDateTime` and does not label them as UTC. A later schema change must add distinct raw/local and UTC fields before CargoRun can safely convert `StsTime` using the resolved station timezone.

Phase 2B binds live machine ingestion to the enabled `MEL` station resolved from `CargoRunStations`; `MEL` must use `Australia/Melbourne`. The shared fixture for future testing maps `AKL` to `Pacific/Auckland`, but Phase 2B does not seed or enable AKL operationally.
