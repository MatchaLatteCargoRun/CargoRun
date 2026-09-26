-- READ ONLY. Flight-only detail extractor for STOP findings from multi-station-foundation-preflight.sql.
-- Emits exactly one result set containing flight-level STOP details.
SET NOCOUNT ON;

DECLARE @FlightsObjectId int=OBJECT_ID(N'dbo.Flights',N'U');
DECLARE @MachObjectId int=OBJECT_ID(N'dbo.IncomingMachMessages',N'U');
DECLARE @FowObjectId int=OBJECT_ID(N'dbo.MachFowShipments',N'U');
DECLARE @ExecutableSql nvarchar(max);

-- Phase 2B operator-confirmed scope for existing MEL test data only.
DECLARE @OperatorConfirmedExistingOperationalRowsAreMel bit=1;

DECLARE @FlightCoreReady bit=CASE WHEN @FlightsObjectId IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightNumber') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'OperatingDate') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'Direction') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightStatus') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'OriginAirport') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'DestinationAirport') IS NOT NULL THEN 1 ELSE 0 END;

DECLARE @MachCoreReady bit=CASE WHEN @MachObjectId IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorID') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId') IS NOT NULL THEN 1 ELSE 0 END;

-- Optional source fields are selected only when the live columns exist.
DECLARE @FlightSourceExpression nvarchar(400)=CASE
  WHEN COL_LENGTH(N'dbo.Flights',N'SourceType') IS NOT NULL THEN N'CONVERT(nvarchar(100),f.SourceType)'
  WHEN COL_LENGTH(N'dbo.Flights',N'Source') IS NOT NULL THEN N'CONVERT(nvarchar(100),f.Source)'
  WHEN COL_LENGTH(N'dbo.Flights',N'CreatedSource') IS NOT NULL THEN N'CONVERT(nvarchar(100),f.CreatedSource)'
  ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @FlightCreatedExpression nvarchar(400)=CASE
  WHEN COL_LENGTH(N'dbo.Flights',N'CreatedAtUtc') IS NOT NULL THEN N'CONVERT(datetime2(3),f.CreatedAtUtc)'
  WHEN COL_LENGTH(N'dbo.Flights',N'CreatedAt') IS NOT NULL THEN N'CONVERT(datetime2(3),f.CreatedAt)'
  ELSE N'CAST(NULL AS datetime2(3))' END;

-- MACH evidence is kept metadata-gated because historical schemas may lack modern fields.
DECLARE @MachEvidenceOriginExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'OriginAirport') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.OriginAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentOrigin') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentOrigin)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachEvidenceDestinationExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'DestinationAirport') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.DestinationAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentDestination') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentDestination)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachEvidenceCte nvarchar(max);
IF @MachCoreReady=1 AND COL_LENGTH(N'dbo.IncomingMachMessages',N'StationAirport') IS NOT NULL
  SET @MachEvidenceCte=N'
    SELECT TRY_CONVERT(bigint,message.MatchedFlightId) AS FlightId,
      SUM(CASE WHEN UPPER(LTRIM(RTRIM(message.StationAirport)))=N''MEL'' THEN 1 ELSE 0 END) AS MachMelCount,
      SUM(CASE WHEN NULLIF(LTRIM(RTRIM(message.StationAirport)),N'''') IS NOT NULL
                    AND UPPER(LTRIM(RTRIM(message.StationAirport)))<>N''MEL'' THEN 1 ELSE 0 END) AS MachConflictCount,
      SUM(CASE WHEN NULLIF(LTRIM(RTRIM(message.StationAirport)),N'''') IS NULL
                    OR LEN(LTRIM(RTRIM(message.StationAirport)))<>3
                    OR UPPER(LTRIM(RTRIM(message.StationAirport))) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''
               THEN 1 ELSE 0 END) AS MachInvalidCount
      ,SUM(CASE
        WHEN matchedFlight.FlightId IS NOT NULL
          AND ('+@MachEvidenceOriginExpression+N' IS NOT NULL
            AND UPPER(LTRIM(RTRIM('+@MachEvidenceOriginExpression+N')))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),matchedFlight.OriginAirport))))
            OR '+@MachEvidenceDestinationExpression+N' IS NOT NULL
            AND UPPER(LTRIM(RTRIM('+@MachEvidenceDestinationExpression+N')))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),matchedFlight.DestinationAirport)))))
          THEN 1 ELSE 0 END) AS MachRouteConflictCount
    FROM dbo.IncomingMachMessages message
    LEFT JOIN dbo.Flights matchedFlight ON matchedFlight.FlightId=TRY_CONVERT(bigint,message.MatchedFlightId)
    WHERE message.MatchedFlightId IS NOT NULL
    GROUP BY TRY_CONVERT(bigint,message.MatchedFlightId)';
ELSE
  SET @MachEvidenceCte=N'
    SELECT CAST(NULL AS bigint) AS FlightId,CONVERT(bigint,0) AS MachMelCount,
      CONVERT(bigint,0) AS MachConflictCount,CONVERT(bigint,0) AS MachInvalidCount,
      CONVERT(bigint,0) AS MachRouteConflictCount
    WHERE 1=0';

DECLARE @FlightClassificationCte nvarchar(max)=N'WITH MachEvidence AS ('+@MachEvidenceCte+N'),
  FlightEvidence AS (
    SELECT f.FlightId,f.FlightNumber,f.OperatingDate,f.Direction,f.FlightStatus,
      f.OriginAirport,f.DestinationAirport,'+@FlightSourceExpression+N' AS SourceIndicator,
      '+@FlightCreatedExpression+N' AS CreatedAtUtc,
      COALESCE(m.MachMelCount,0) AS MachMelCount,
      COALESCE(m.MachConflictCount,0) AS MachConflictCount,
      COALESCE(m.MachInvalidCount,0) AS MachInvalidCount,
      COALESCE(m.MachRouteConflictCount,0) AS MachRouteConflictCount,
      CONVERT(bit,'+CONVERT(nvarchar(1),@OperatorConfirmedExistingOperationalRowsAreMel)+N') AS OperatorConfirmedExistingOperationalRowsAreMel,
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(30),f.Direction)))) AS DirectionKey,
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),f.OriginAirport)))) AS OriginKey,
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),f.DestinationAirport)))) AS DestinationKey
    FROM dbo.Flights f
    LEFT JOIN MachEvidence m ON m.FlightId=TRY_CONVERT(bigint,f.FlightId)
  ), ClassifiedFlights AS (
    SELECT evidence.*,
      CASE
        WHEN NULLIF(evidence.DirectionKey,N'''') IS NULL
          OR evidence.DirectionKey NOT IN (N''IMPORT'',N''EXPORT'')
          OR (NULLIF(evidence.OriginKey,N'''') IS NOT NULL AND
            (LEN(evidence.OriginKey) NOT IN (3,4)
              OR evidence.OriginKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''))
          OR (NULLIF(evidence.DestinationKey,N'''') IS NOT NULL AND
            (LEN(evidence.DestinationKey) NOT IN (3,4)
              OR evidence.DestinationKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''))
          OR (NULLIF(evidence.OriginKey,N'''') IS NOT NULL AND evidence.OriginKey=evidence.DestinationKey)
          OR (evidence.DirectionKey=N''IMPORT'' AND NULLIF(evidence.DestinationKey,N'''') IS NOT NULL
            AND evidence.DestinationKey<>N''MEL'')
          OR (evidence.DirectionKey=N''EXPORT'' AND NULLIF(evidence.OriginKey,N'''') IS NOT NULL
            AND evidence.OriginKey<>N''MEL'')
          OR evidence.MachConflictCount>0 OR evidence.MachInvalidCount>0 OR evidence.MachRouteConflictCount>0
          THEN N''CONTRADICTORY''
        WHEN evidence.MachMelCount>0 THEN N''SAFE_MEL_CANDIDATE''
        WHEN evidence.OperatorConfirmedExistingOperationalRowsAreMel=1
          AND (NULLIF(evidence.OriginKey,N'''') IS NULL OR NULLIF(evidence.DestinationKey,N'''') IS NULL)
          THEN N''OPERATOR_CONFIRMED_MEL_BACKFILL''
        ELSE N''AMBIGUOUS''
      END AS OwnershipClassification,
      CASE
        WHEN NULLIF(evidence.DirectionKey,N'''') IS NULL THEN N''Direction is null or blank''
        WHEN evidence.DirectionKey NOT IN (N''IMPORT'',N''EXPORT'') THEN N''Direction is unsupported''
        WHEN (NULLIF(evidence.OriginKey,N'''') IS NOT NULL AND
            (LEN(evidence.OriginKey) NOT IN (3,4)
              OR evidence.OriginKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''))
          OR (NULLIF(evidence.DestinationKey,N'''') IS NOT NULL AND
            (LEN(evidence.DestinationKey) NOT IN (3,4)
              OR evidence.DestinationKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''))
          THEN N''Nonblank airport code is malformed''
        WHEN NULLIF(evidence.OriginKey,N'''') IS NOT NULL AND evidence.OriginKey=evidence.DestinationKey THEN N''Origin and destination are identical''
        WHEN evidence.DirectionKey=N''IMPORT'' AND NULLIF(evidence.DestinationKey,N'''') IS NOT NULL
          AND evidence.DestinationKey<>N''MEL'' THEN N''Import destination is not MEL''
        WHEN evidence.DirectionKey=N''EXPORT'' AND NULLIF(evidence.OriginKey,N'''') IS NOT NULL
          AND evidence.OriginKey<>N''MEL'' THEN N''Export origin is not MEL''
        WHEN evidence.MachConflictCount>0 THEN N''MACH station contradicts MEL ownership''
        WHEN evidence.MachInvalidCount>0 THEN N''Matched MACH station is null or malformed''
        WHEN evidence.MachRouteConflictCount>0 THEN N''Matched MACH segment contradicts the flight route''
        WHEN evidence.MachMelCount>0 THEN N''Route and matched MACH station support MEL''
        WHEN evidence.OperatorConfirmedExistingOperationalRowsAreMel=1
          AND (NULLIF(evidence.OriginKey,N'''') IS NULL OR NULLIF(evidence.DestinationKey,N'''') IS NULL)
          THEN N''Incomplete legacy route accepted only by the operator-confirmed MEL backfill policy''
        ELSE N''Route is MEL-consistent but lacks independent database corroboration''
      END AS ClassificationReason
    FROM FlightEvidence evidence
  )';

-- 12. Canonical identity preflight. The normalizer mirrors api/shared/flight.js for parity-safe rows.
-- JavaScript \s and Number semantics cannot be guaranteed for unusual Unicode whitespace or long numbers;
-- those rows are deliberately excluded from collision decisions and returned for application-assisted verification.
DECLARE @CanonicalCte nvarchar(max)=N'WITH RawFlightIdentity AS (
    SELECT f.FlightId,f.OperatingDate,f.Direction,f.FlightStatus,'+@FlightSourceExpression+N' AS SourceIndicator,
      CONVERT(nvarchar(4000),f.FlightNumber) AS OriginalFlightNumber,
      UPPER(REPLACE(REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(CONVERT(nvarchar(4000),f.FlightNumber))),
        N'' '',N''''),NCHAR(9),N''''),NCHAR(10),N''''),NCHAR(13),N'''')) AS CompactFlightNumber
    FROM dbo.Flights f
  ), ParsedFlightIdentity AS (
    SELECT raw.*,
      CASE WHEN SUBSTRING(raw.CompactFlightNumber,3,1) COLLATE Latin1_General_100_BIN2 LIKE N''[0-9]'' THEN 2
           WHEN SUBSTRING(raw.CompactFlightNumber,4,1) COLLATE Latin1_General_100_BIN2 LIKE N''[0-9]'' THEN 3
           ELSE NULL END AS PrefixLength,
      CASE WHEN RIGHT(raw.CompactFlightNumber,1) COLLATE Latin1_General_100_BIN2 LIKE N''[A-Z]'' THEN 1 ELSE 0 END AS SuffixLength,
      CASE WHEN CONVERT(nvarchar(4000),raw.OriginalFlightNumber) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Za-z0-9 ''+NCHAR(9)+NCHAR(10)+NCHAR(13)+N'']%''
           THEN 1 ELSE 0 END AS HasUnmodelledWhitespaceOrCharacter
    FROM RawFlightIdentity raw
  ), NumericFlightIdentity AS (
    SELECT parsed.*,
      CASE WHEN parsed.PrefixLength IS NULL THEN NULL
           ELSE SUBSTRING(parsed.CompactFlightNumber,parsed.PrefixLength+1,
             LEN(parsed.CompactFlightNumber)-parsed.PrefixLength-parsed.SuffixLength) END AS NumericSegment
    FROM ParsedFlightIdentity parsed
  ), CanonicalFlightIdentity AS (
    SELECT numericPart.*,
      CASE WHEN numericPart.PrefixLength IS NOT NULL
             AND NULLIF(numericPart.NumericSegment,N'''') IS NOT NULL
             AND numericPart.NumericSegment COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9]%''
             AND LEN(numericPart.NumericSegment)<=15
             AND numericPart.HasUnmodelledWhitespaceOrCharacter=0
           THEN CONVERT(bit,1) ELSE CONVERT(bit,0) END AS SqlParityGuaranteed,
      CASE WHEN numericPart.PrefixLength IS NOT NULL
             AND NULLIF(numericPart.NumericSegment,N'''') IS NOT NULL
             AND numericPart.NumericSegment COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9]%''
             AND LEN(numericPart.NumericSegment)<=15
             AND numericPart.HasUnmodelledWhitespaceOrCharacter=0
           THEN LEFT(numericPart.CompactFlightNumber,numericPart.PrefixLength)
             +CONVERT(nvarchar(40),CONVERT(decimal(38,0),numericPart.NumericSegment))
             +CASE WHEN numericPart.SuffixLength=1 THEN RIGHT(numericPart.CompactFlightNumber,1) ELSE N'''' END
           WHEN numericPart.HasUnmodelledWhitespaceOrCharacter=0 THEN numericPart.CompactFlightNumber
           ELSE NULL END AS NormalizedFlightNumber
    FROM NumericFlightIdentity numericPart
  )';

-- Review-only evidence projections are metadata-gated independently from the shared classifier.
DECLARE @MachMessageIdExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NOT NULL THEN N'TRY_CONVERT(bigint,message.MachMessageId)' ELSE N'CAST(NULL AS bigint)' END;
DECLARE @MachDocumentExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorID') IS NOT NULL THEN N'CONVERT(nvarchar(200),message.DocumentCorID)' ELSE N'CAST(NULL AS nvarchar(200))' END;
DECLARE @MachStationExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'StationAirport') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.StationAirport)' ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachOriginExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'OriginAirport') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.OriginAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'StsSegDep') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.StsSegDep)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentOrigin') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentOrigin)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachDestinationExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'DestinationAirport') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.DestinationAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'StsSegArr') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.StsSegArr)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentDestination') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentDestination)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachSourceExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SourceType') IS NOT NULL THEN N'CONVERT(nvarchar(100),message.SourceType)' ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @MachTypeExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'MessageType') IS NOT NULL THEN N'CONVERT(nvarchar(100),message.MessageType)' ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @MachStatusExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'ProcessingStatus') IS NOT NULL THEN N'CONVERT(nvarchar(100),message.ProcessingStatus)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'StatusCode') IS NOT NULL THEN N'CONVERT(nvarchar(100),message.StatusCode)'
  ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @MachFlightNumberExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'FlightNumber') IS NOT NULL THEN N'CONVERT(nvarchar(100),message.FlightNumber)' ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @MachOperatingDateExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'OperatingDate') IS NOT NULL THEN N'TRY_CONVERT(date,message.OperatingDate)' ELSE N'CAST(NULL AS date)' END;
DECLARE @MachObservedExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'ReceivedAtUtc') IS NOT NULL THEN N'TRY_CONVERT(datetime2(3),message.ReceivedAtUtc)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'CreatedAtUtc') IS NOT NULL THEN N'TRY_CONVERT(datetime2(3),message.CreatedAtUtc)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'ProcessedAtUtc') IS NOT NULL THEN N'TRY_CONVERT(datetime2(3),message.ProcessedAtUtc)'
  ELSE N'CAST(NULL AS datetime2(3))' END;

DECLARE @MessageDetailCte nvarchar(max);
IF @MachObjectId IS NOT NULL AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId') IS NOT NULL
  SET @MessageDetailCte=N'
    SELECT TRY_CONVERT(bigint,message.MatchedFlightId) AS FlightId,
      TRY_CONVERT(bigint,message.MatchedFlightId) AS MatchedFlightId,
      '+@MachMessageIdExpression+N' AS MachMessageId,'+@MachDocumentExpression+N' AS DocumentCorID,
      '+@MachStationExpression+N' AS StationAirport,'+@MachOriginExpression+N' AS SegmentOrigin,
      '+@MachDestinationExpression+N' AS SegmentDestination,'+@MachSourceExpression+N' AS MachSourceType,
      '+@MachTypeExpression+N' AS MachMessageType,'+@MachStatusExpression+N' AS MachStatus,
      '+@MachFlightNumberExpression+N' AS MachFlightNumber,'+@MachOperatingDateExpression+N' AS MachOperatingDate,
      '+@MachObservedExpression+N' AS MachObservedAtUtc
    FROM dbo.IncomingMachMessages message
    WHERE message.MatchedFlightId IS NOT NULL';
ELSE
  SET @MessageDetailCte=N'
    SELECT CAST(NULL AS bigint) AS FlightId,CAST(NULL AS bigint) AS MatchedFlightId,
      CAST(NULL AS bigint) AS MachMessageId,
      CAST(NULL AS nvarchar(200)) AS DocumentCorID,CAST(NULL AS nvarchar(20)) AS StationAirport,
      CAST(NULL AS nvarchar(20)) AS SegmentOrigin,CAST(NULL AS nvarchar(20)) AS SegmentDestination,
      CAST(NULL AS nvarchar(100)) AS MachSourceType,CAST(NULL AS nvarchar(100)) AS MachMessageType,
      CAST(NULL AS nvarchar(100)) AS MachStatus,CAST(NULL AS nvarchar(100)) AS MachFlightNumber,
      CAST(NULL AS date) AS MachOperatingDate,CAST(NULL AS datetime2(3)) AS MachObservedAtUtc
    WHERE 1=0';

DECLARE @FowMessageExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL THEN N'TRY_CONVERT(bigint,shipment.MachMessageId)' ELSE N'CAST(NULL AS bigint)' END;
DECLARE @FowUldIdExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.MachFowShipments',N'UldId') IS NOT NULL THEN N'CONVERT(nvarchar(100),shipment.UldId)' ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @FowUldNumberExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.MachFowShipments',N'UldNumber') IS NOT NULL THEN N'CONVERT(nvarchar(100),shipment.UldNumber)' ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @FowMawbExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.MachFowShipments',N'MawbNumber') IS NOT NULL THEN N'CONVERT(nvarchar(100),shipment.MawbNumber)' ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @FowPiecesExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.MachFowShipments',N'Pieces') IS NOT NULL THEN N'TRY_CONVERT(bigint,shipment.Pieces)' ELSE N'CAST(NULL AS bigint)' END;
DECLARE @FowDetailCte nvarchar(max);
IF @FowObjectId IS NOT NULL AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL
  SET @FowDetailCte=N'
    SELECT TRY_CONVERT(bigint,shipment.FlightId) AS FlightId,'+@FowMessageExpression+N' AS MachMessageId,
      '+@FowUldIdExpression+N' AS FowUldId,'+@FowUldNumberExpression+N' AS FowUldNumber,
      '+@FowMawbExpression+N' AS MawbNumber,'+@FowPiecesExpression+N' AS Pieces
    FROM dbo.MachFowShipments shipment';
ELSE
  SET @FowDetailCte=N'
    SELECT CAST(NULL AS bigint) AS FlightId,CAST(NULL AS bigint) AS MachMessageId,
      CAST(NULL AS nvarchar(100)) AS FowUldId,CAST(NULL AS nvarchar(100)) AS FowUldNumber,
      CAST(NULL AS nvarchar(100)) AS MawbNumber,CAST(NULL AS bigint) AS Pieces
    WHERE 1=0';

-- The only result set: every flight behind an ownership or canonical-identity STOP finding.
IF @FlightCoreReady=1
BEGIN
  SET @ExecutableSql=@FlightClassificationCte+N','+STUFF(@CanonicalCte,1,5,N'')+N',
  CanonicalCollisionKeys AS (
    SELECT OperatingDate,NormalizedFlightNumber
    FROM CanonicalFlightIdentity
    WHERE NormalizedFlightNumber IS NOT NULL
    GROUP BY OperatingDate,NormalizedFlightNumber
    HAVING COUNT_BIG(*)>1
  ), ReviewFlights AS (
    SELECT classified.*,canonical.OriginalFlightNumber,canonical.CompactFlightNumber,
      canonical.NormalizedFlightNumber,canonical.NumericSegment,canonical.SqlParityGuaranteed,
      canonical.HasUnmodelledWhitespaceOrCharacter,
      CONVERT(bit,CASE WHEN collision.NormalizedFlightNumber IS NULL THEN 0 ELSE 1 END) AS CanonicalIdentityCollision,
      CONVERT(bit,CASE WHEN canonical.SqlParityGuaranteed=0
        AND (canonical.HasUnmodelledWhitespaceOrCharacter=1 OR LEN(COALESCE(canonical.NumericSegment,N''''))>15)
        THEN 1 ELSE 0 END) AS ApplicationAssistedNormalizationRequired
    FROM ClassifiedFlights classified
    JOIN CanonicalFlightIdentity canonical ON canonical.FlightId=classified.FlightId
    LEFT JOIN CanonicalCollisionKeys collision
      ON collision.OperatingDate=canonical.OperatingDate
     AND collision.NormalizedFlightNumber=canonical.NormalizedFlightNumber
    WHERE classified.OwnershipClassification IN (N''CONTRADICTORY'',N''AMBIGUOUS'')
       OR collision.NormalizedFlightNumber IS NOT NULL
       OR (canonical.SqlParityGuaranteed=0
         AND (canonical.HasUnmodelledWhitespaceOrCharacter=1 OR LEN(COALESCE(canonical.NumericSegment,N''''))>15))
  ), MessageDetails AS ('+@MessageDetailCte+N'), FowDetails AS ('+@FowDetailCte+N'),
  EvidenceRows AS (
    SELECT message.FlightId,message.MatchedFlightId,shipment.FlightId AS FowFlightId,
      message.MachMessageId,message.DocumentCorID,message.StationAirport,
      message.SegmentOrigin,message.SegmentDestination,message.MachSourceType,message.MachMessageType,
      message.MachStatus,message.MachFlightNumber,message.MachOperatingDate,message.MachObservedAtUtc,
      shipment.FowUldId,shipment.FowUldNumber,shipment.MawbNumber,shipment.Pieces,
      CASE WHEN shipment.FlightId IS NULL THEN N''MATCHED_MACH'' ELSE N''MATCHED_MACH_WITH_FOW'' END AS EvidenceLink
    FROM MessageDetails message
    LEFT JOIN FowDetails shipment
      ON shipment.FlightId=message.FlightId AND shipment.MachMessageId=message.MachMessageId
    UNION ALL
    SELECT shipment.FlightId,CAST(NULL AS bigint),shipment.FlightId,
      shipment.MachMessageId,CAST(NULL AS nvarchar(200)),CAST(NULL AS nvarchar(20)),
      CAST(NULL AS nvarchar(20)),CAST(NULL AS nvarchar(20)),CAST(NULL AS nvarchar(100)),CAST(NULL AS nvarchar(100)),
      CAST(NULL AS nvarchar(100)),CAST(NULL AS nvarchar(100)),CAST(NULL AS date),CAST(NULL AS datetime2(3)),
      shipment.FowUldId,shipment.FowUldNumber,shipment.MawbNumber,shipment.Pieces,N''FOW_WITHOUT_MATCHED_MACH''
    FROM FowDetails shipment
    WHERE NOT EXISTS (
      SELECT 1 FROM MessageDetails message
      WHERE message.FlightId=shipment.FlightId AND message.MachMessageId=shipment.MachMessageId
    )
  )
  SELECT review.FlightId,review.FlightNumber,review.OperatingDate,review.Direction,
    review.OriginAirport,review.DestinationAirport,review.FlightStatus,
    STUFF(CONCAT(
      CASE WHEN review.OwnershipClassification=N''CONTRADICTORY'' THEN N'';CONTRADICTORY_ROUTE'' ELSE N'''' END,
      CASE WHEN review.OwnershipClassification=N''AMBIGUOUS'' THEN N'';AMBIGUOUS_FLIGHT'' ELSE N'''' END,
      CASE WHEN review.CanonicalIdentityCollision=1 THEN N'';CANONICAL_IDENTITY_COLLISION'' ELSE N'''' END,
      CASE WHEN review.ApplicationAssistedNormalizationRequired=1 THEN N'';APPLICATION_ASSISTED_NORMALIZATION_REQUIRED'' ELSE N'''' END
    ),1,1,N'''') AS Classification,
    CONCAT_WS(N''; '',
      CASE WHEN review.OwnershipClassification IN (N''CONTRADICTORY'',N''AMBIGUOUS'') THEN review.ClassificationReason END,
      CASE WHEN review.CanonicalIdentityCollision=1 THEN N''Multiple FlightIds share OperatingDate plus the application-equivalent normalized FlightNumber.'' END,
      CASE WHEN review.ApplicationAssistedNormalizationRequired=1 THEN N''SQL cannot guarantee parity with JavaScript whitespace/Number semantics for this flight number.'' END
    ) AS ClassificationReason,
    review.OwnershipClassification,review.ClassificationReason AS OwnershipClassificationReason,
    review.SourceIndicator,review.CreatedAtUtc,review.OriginalFlightNumber,review.CompactFlightNumber,
    review.NormalizedFlightNumber AS CanonicalFlightNumber,
    CASE WHEN review.OperatingDate IS NULL OR review.NormalizedFlightNumber IS NULL THEN NULL
      ELSE CONCAT(CONVERT(char(10),review.OperatingDate,23),N''|'',review.NormalizedFlightNumber) END AS CanonicalIdentityKey,
    review.SqlParityGuaranteed,review.CanonicalIdentityCollision,
    review.ApplicationAssistedNormalizationRequired,review.MachMelCount,review.MachConflictCount,
    review.MachInvalidCount,review.MachRouteConflictCount,
    evidence.MatchedFlightId,evidence.FowFlightId,evidence.MachMessageId,evidence.DocumentCorID,
    evidence.StationAirport,evidence.SegmentOrigin,
    evidence.SegmentDestination,evidence.MachSourceType,evidence.MachMessageType,evidence.MachStatus,
    evidence.MachFlightNumber,evidence.MachOperatingDate,evidence.MachObservedAtUtc,
    evidence.FowUldId,evidence.FowUldNumber,evidence.MawbNumber,evidence.Pieces,
    COALESCE(evidence.EvidenceLink,N''NO_MATCHED_MACH_OR_FOW_EVIDENCE'') AS EvidenceLink
  FROM ReviewFlights review
  LEFT JOIN EvidenceRows evidence ON evidence.FlightId=TRY_CONVERT(bigint,review.FlightId)
  ORDER BY review.OperatingDate,review.FlightId,evidence.MachMessageId,evidence.FowUldId;';
END;
ELSE
  SET @ExecutableSql=N'
    SELECT CAST(NULL AS bigint) AS FlightId,CAST(NULL AS nvarchar(100)) AS FlightNumber,
      CAST(NULL AS date) AS OperatingDate,CAST(NULL AS nvarchar(30)) AS Direction,
      CAST(NULL AS nvarchar(20)) AS OriginAirport,CAST(NULL AS nvarchar(20)) AS DestinationAirport,
      CAST(NULL AS nvarchar(50)) AS FlightStatus,N''MISSING_REQUIRED_SCHEMA'' AS Classification,
      N''Flights core identity, route, or lifecycle columns are missing.'' AS ClassificationReason,
      N''SCHEMA_UNAVAILABLE'' AS OwnershipClassification,
      N''Flights core identity, route, or lifecycle columns are missing.'' AS OwnershipClassificationReason,
      CAST(NULL AS nvarchar(100)) AS SourceIndicator,CAST(NULL AS datetime2(3)) AS CreatedAtUtc,
      CAST(NULL AS nvarchar(4000)) AS OriginalFlightNumber,CAST(NULL AS nvarchar(4000)) AS CompactFlightNumber,
      CAST(NULL AS nvarchar(4000)) AS CanonicalFlightNumber,CAST(NULL AS nvarchar(4020)) AS CanonicalIdentityKey,
      CAST(NULL AS bit) AS SqlParityGuaranteed,CAST(NULL AS bit) AS CanonicalIdentityCollision,
      CAST(NULL AS bit) AS ApplicationAssistedNormalizationRequired,
      CAST(NULL AS bigint) AS MachMelCount,CAST(NULL AS bigint) AS MachConflictCount,
      CAST(NULL AS bigint) AS MachInvalidCount,CAST(NULL AS bigint) AS MachRouteConflictCount,
      CAST(NULL AS bigint) AS MatchedFlightId,CAST(NULL AS bigint) AS FowFlightId,
      CAST(NULL AS bigint) AS MachMessageId,CAST(NULL AS nvarchar(200)) AS DocumentCorID,
      CAST(NULL AS nvarchar(20)) AS StationAirport,CAST(NULL AS nvarchar(20)) AS SegmentOrigin,
      CAST(NULL AS nvarchar(20)) AS SegmentDestination,CAST(NULL AS nvarchar(100)) AS MachSourceType,
      CAST(NULL AS nvarchar(100)) AS MachMessageType,CAST(NULL AS nvarchar(100)) AS MachStatus,
      CAST(NULL AS nvarchar(100)) AS MachFlightNumber,CAST(NULL AS date) AS MachOperatingDate,
      CAST(NULL AS datetime2(3)) AS MachObservedAtUtc,CAST(NULL AS nvarchar(100)) AS FowUldId,
      CAST(NULL AS nvarchar(100)) AS FowUldNumber,CAST(NULL AS nvarchar(100)) AS MawbNumber,
      CAST(NULL AS bigint) AS Pieces,N''SCHEMA_UNAVAILABLE'' AS EvidenceLink;';

EXEC sys.sp_executesql @ExecutableSql;
