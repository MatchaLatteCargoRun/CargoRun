# Multi-station timezone foundation

`CargoRunStations.TimeZoneId` is the authoritative IANA timezone for an operational station. `OperatingDate` is the station-local service date. Absolute operational events remain UTC instants, and browser timezone settings never establish station ownership or service date.

`api/shared/station-time.js` is the server-side conversion boundary. It validates explicit UTC instants and strict `YYYY-MM-DD` plus `HH:mm`/`HH:mm:ss` wall-clock input. It never uses the Node process timezone or a fixed offset. `stationDateKey` and `formatInstantInStation` project an absolute instant into a station; `utcBoundsForStationDate` returns the half-open `[startUtc, endUtc)` interval for a station-local date, including 23-hour and 25-hour DST days.

`resolveStationLocalDateTime` returns `UNIQUE` when a wall clock maps to one instant and `NONEXISTENT` with no candidates for a DST gap. During a DST fold it returns `AMBIGUOUS` and the `EARLIER` and `LATER` candidates. A caller must submit one of those disambiguations before the module returns a `RESOLVED` instant. It never shifts a gap or guesses a fold.

The current MACH/FOW schema has only `IncomingMachMessages.EventLocalDateTime` (`datetime2`) for `StsTime`. That type cannot retain an offset, the source timezone, and a separately derived UTC instant. Phase 2B therefore preserves the source wall-clock digits in `EventLocalDateTime` and does not label them as UTC. A later schema change must add distinct raw/local and UTC fields before CargoRun can safely convert `StsTime` using the resolved station timezone.

Phase 2B binds live machine ingestion to the enabled `MEL` station resolved from `CargoRunStations`; `MEL` must use `Australia/Melbourne`. The shared fixture for future testing maps `AKL` to `Pacific/Auckland`, but Phase 2B does not seed or enable AKL operationally.
