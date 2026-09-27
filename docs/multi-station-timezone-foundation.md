# Multi-station timezone foundation

`CargoRunStations.TimeZoneId` is the authoritative IANA timezone for an operational station. `OperatingDate` is the station-local service date. Absolute operational events remain UTC instants, and browser timezone settings never establish station ownership or service date.

`api/shared/station-time.js` is the server-side conversion boundary. It validates explicit UTC instants and strict `YYYY-MM-DD` plus `HH:mm`/`HH:mm:ss` wall-clock input. It never uses the Node process timezone or a fixed offset. `stationDateKey` and `formatInstantInStation` project an absolute instant into a station; `utcBoundsForStationDate` returns the half-open `[startUtc, endUtc)` interval for a station-local date, including 23-hour and 25-hour DST days.

`resolveStationLocalDateTime` returns `UNIQUE` when a wall clock maps to one instant and `NONEXISTENT` with no candidates for a DST gap. During a DST fold it returns `AMBIGUOUS` and the `EARLIER` and `LATER` candidates. A caller must submit one of those disambiguations before the module returns a `RESOLVED` instant. It never shifts a gap or guesses a fold.

The current MACH/FOW schema has only `IncomingMachMessages.EventLocalDateTime` (`datetime2`) for `StsTime`. That type cannot retain an offset, the source timezone, and a separately derived UTC instant. Phase 2B therefore preserves the source wall-clock digits in `EventLocalDateTime` and does not label them as UTC. A later schema change must add distinct raw/local and UTC fields before CargoRun can safely convert `StsTime` using the resolved station timezone.

Live MACH/FOW ingestion uses the server-only `MACH_FOW_MACHINE_BINDINGS` app setting. It must contain a JSON array of explicit bindings:

```json
[
  {
    "integrationId": "mel-mach-primary",
    "stationId": "1",
    "credential": "replace-with-a-secret-from-the-secure-deployment-store",
    "enabled": true
  }
]
```

`integrationId` is a non-secret audit label containing 1-100 ASCII letters, digits, dots, underscores, colons, or hyphens. `stationId` is the positive SQL `bigint` identity of one `CargoRunStations` row. `credential` is an exact 16-512 character server secret with no whitespace, control character, or comma. `enabled` is mandatory. Integration IDs and credentials must each be unique. The entire configuration fails closed if JSON or any binding is invalid, missing a station binding, or ambiguous. The legacy `MACH_FOW_INGEST_TOKEN` value is not accepted as an unbound fallback.

External machines send exactly one credential mechanism: either `X-CargoRun-MACH-Key` or `Authorization: Bearer`. Query-string credentials are rejected. Supplying both machine mechanisms, duplicate/combined credential headers, or a machine credential alongside a SWA browser principal is rejected as ambiguous.

The credential selects its bound `StationId`; request fields and XML never select ownership. CargoRun resolves that ID to one enabled station before parsing operational content. `StsApt` and outbound segment origin remain validation evidence under the existing FOW rules: present contradictory evidence is rejected, while the already-supported absence of optional segment evidence remains accepted. Cargo destination remains non-authoritative. `StsDatt`, `StsTime`, and `RawXml` retain their existing evidence semantics.

For deployment, the current MEL integration must be provisioned as an explicit enabled binding to the verified MEL `StationId` before the new code receives machine traffic. Adding BNE, SYD, or another station requires creating and validating the station, provisioning a distinct secret, adding one binding, and enabling it after controlled tests; no source-code station condition is required. AKL remains a test fixture only. Before controlled AKL activation, operators must create and verify the AKL station and timezone, complete all authorization and ownership prerequisites, provision a unique AKL secret and binding, validate matching and contradictory XML cases plus global DocumentCorID confidentiality, and then deliberately enable the integration. This repository change does not create AKL production settings, grants, or data.
