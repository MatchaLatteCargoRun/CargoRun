[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TargetServer = 'cargorun-sql-xxxxx.database.windows.net'
$TargetServerName = 'cargorun-sql-xxxxx'
$TargetDatabase = 'cargorun-db'
$TargetUser = 'CargoRun_Preflight_ReadOnly'
$SqlPath = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '..\migrations\live-amendment-preflight.sql')
)
$ReportPath = Join-Path $env:TEMP 'CargoRun-live-amendment-preflight.json'
$ForbiddenKeywords = @('INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE')

$securePassword = $null
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$connectionString = $null
$connectionBuilder = $null
$connection = $null
$command = $null
$reader = $null
$failureMessage = $null
$preflightClean = $false
$staticSummary = @()
$v1Summary = [ordered]@{ Total = 0; Passed = 0; Failed = 0 }
$stopSummary = @()

function Get-CommentFreeSql {
    param([Parameter(Mandatory)][string]$Sql)

    $output = [System.Text.StringBuilder]::new($Sql.Length)
    $state = 'Code'
    $blockDepth = 0

    for ($index = 0; $index -lt $Sql.Length; $index++) {
        $current = $Sql[$index]
        $next = if ($index + 1 -lt $Sql.Length) { $Sql[$index + 1] } else { [char]0 }

        switch ($state) {
            'Code' {
                if ($current -eq '-' -and $next -eq '-') {
                    [void]$output.Append(' ')
                    [void]$output.Append(' ')
                    $index++
                    $state = 'LineComment'
                }
                elseif ($current -eq '/' -and $next -eq '*') {
                    [void]$output.Append(' ')
                    [void]$output.Append(' ')
                    $index++
                    $blockDepth = 1
                    $state = 'BlockComment'
                }
                else {
                    [void]$output.Append($current)
                }
            }
            'LineComment' {
                if ($current -eq "`r" -or $current -eq "`n") {
                    [void]$output.Append($current)
                    $state = 'Code'
                }
                else {
                    [void]$output.Append(' ')
                }
            }
            'BlockComment' {
                if ($current -eq '/' -and $next -eq '*') {
                    [void]$output.Append(' ')
                    [void]$output.Append(' ')
                    $index++
                    $blockDepth++
                }
                elseif ($current -eq '*' -and $next -eq '/') {
                    [void]$output.Append(' ')
                    [void]$output.Append(' ')
                    $index++
                    $blockDepth--
                    if ($blockDepth -eq 0) { $state = 'Code' }
                }
                elseif ($current -eq "`r" -or $current -eq "`n") {
                    [void]$output.Append($current)
                }
                else {
                    [void]$output.Append(' ')
                }
            }
        }
    }

    if ($state -eq 'BlockComment') {
        throw 'The preflight SQL contains an unterminated block comment.'
    }

    return $output.ToString()
}

function Assert-ReadOnlySql {
    param([Parameter(Mandatory)][string]$Sql)

    # Comments are removed, while string payloads are deliberately retained.
    # This also inspects SQL executed through sp_executesql string literals.
    $commentFreeSql = Get-CommentFreeSql -Sql $Sql
    $pattern = '(?i)(?<![A-Za-z0-9_])(?:' +
        (($ForbiddenKeywords | ForEach-Object { [regex]::Escape($_) }) -join '|') +
        ')(?![A-Za-z0-9_])'
    $matches = [regex]::Matches($commentFreeSql, $pattern)

    if ($matches.Count -gt 0) {
        $found = $matches | ForEach-Object { $_.Value.ToUpperInvariant() } | Sort-Object -Unique
        throw "Refusing to run SQL containing forbidden keyword(s): $($found -join ', ')"
    }
}

function Invoke-SingleResultQuery {
    param(
        [Parameter(Mandatory)][System.Data.SqlClient.SqlConnection]$SqlConnection,
        [Parameter(Mandatory)][string]$Query
    )

    $sqlCommand = $SqlConnection.CreateCommand()
    try {
        $sqlCommand.CommandText = $Query
        $sqlCommand.CommandTimeout = 30
        $sqlReader = $sqlCommand.ExecuteReader()
        try {
            if (-not $sqlReader.Read()) {
                throw 'Permission/identity verification returned no row.'
            }

            $row = [ordered]@{}
            for ($field = 0; $field -lt $sqlReader.FieldCount; $field++) {
                $value = $sqlReader.GetValue($field)
                $row[$sqlReader.GetName($field)] = if ($value -is [DBNull]) { $null } else { $value }
            }
            return $row
        }
        finally {
            $sqlReader.Dispose()
        }
    }
    finally {
        $sqlCommand.Dispose()
    }
}

function Convert-SqlValueForReport {
    param($Value)

    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('o') }
    if ($Value -is [datetimeoffset]) { return $Value.ToUniversalTime().ToString('o') }
    if ($Value -is [guid]) { return $Value.ToString() }
    if ($Value -is [byte[]]) { return [Convert]::ToBase64String($Value) }
    return $Value
}

function Get-RowSection {
    param($Row)

    if ($null -eq $Row -or -not $Row.Contains('Section') -or $null -eq $Row['Section']) {
        return ''
    }
    return [string]$Row['Section']
}

function Test-JsonObject {
    param([Parameter(Mandatory)][string]$Json)

    try {
        $parsed = $Json | ConvertFrom-Json -ErrorAction Stop
        return $null -ne $parsed -and
            -not ($parsed -is [System.Array]) -and
            ($parsed -is [pscustomobject] -or $parsed -is [System.Collections.IDictionary])
    }
    catch {
        return $false
    }
}

function Write-SanitizedReport {
    param([Parameter(Mandatory)]$Report)

    $json = $Report | ConvertTo-Json -Depth 20
    $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($ReportPath, $json, $utf8WithoutBom)
}

try {
    if (-not (Test-Path -LiteralPath $SqlPath -PathType Leaf)) {
        throw "Preflight SQL was not found: $SqlPath"
    }

    $sqlText = [System.IO.File]::ReadAllText($SqlPath)
    Assert-ReadOnlySql -Sql $sqlText

    $securePassword = Read-Host 'SQL password for CargoRun_Preflight_ReadOnly' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    $connectionBuilder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
    $connectionBuilder['Data Source'] = "tcp:$TargetServer,1433"
    $connectionBuilder['Initial Catalog'] = $TargetDatabase
    $connectionBuilder['User ID'] = $TargetUser
    $connectionBuilder['Password'] = $plainPassword
    $connectionBuilder['Integrated Security'] = $false
    $connectionBuilder['Encrypt'] = $true
    $connectionBuilder['TrustServerCertificate'] = $false
    $connectionBuilder['Connect Timeout'] = 30
    $connectionString = $connectionBuilder.ConnectionString

    if ($connectionBuilder['Data Source'] -cne "tcp:$TargetServer,1433" -or
        $connectionBuilder['Initial Catalog'] -cne $TargetDatabase -or
        $connectionBuilder['User ID'] -cne $TargetUser) {
        throw 'Configured SQL target differs from the approved live target.'
    }

    $connection = [System.Data.SqlClient.SqlConnection]::new($connectionString)
    $connection.Open()

    $permissions = Invoke-SingleResultQuery -SqlConnection $connection -Query @'
SELECT
    CONVERT(nvarchar(128), SERVERPROPERTY(N'ServerName')) AS ServerName,
    DB_NAME() AS DatabaseName,
    ORIGINAL_LOGIN() AS OriginalLogin,
    SUSER_SNAME() AS ServerLogin,
    USER_NAME() AS DatabaseUser,
    IS_ROLEMEMBER(N'db_datareader') AS db_datareader,
    IS_ROLEMEMBER(N'db_datawriter') AS db_datawriter,
    IS_ROLEMEMBER(N'db_owner') AS db_owner,
    IS_ROLEMEMBER(N'db_ddladmin') AS db_ddladmin,
    HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CREATE TABLE') AS CreateTablePermission,
    HAS_PERMS_BY_NAME(N'dbo.Flights', N'OBJECT', N'INSERT') AS FlightsInsertPermission,
    HAS_PERMS_BY_NAME(N'dbo.Flights', N'OBJECT', N'UPDATE') AS FlightsUpdatePermission,
    HAS_PERMS_BY_NAME(N'dbo.Flights', N'OBJECT', N'DELETE') AS FlightsDeletePermission,
    HAS_PERMS_BY_NAME(N'dbo.Flights', N'OBJECT', N'ALTER') AS FlightsAlterPermission;
'@

    $connectedServerName = [string]$permissions.ServerName
    if (($connectedServerName -cne $TargetServer -and $connectedServerName -cne $TargetServerName) -or
        [string]$permissions.DatabaseName -cne $TargetDatabase -or
        [string]$permissions.OriginalLogin -cne $TargetUser -or
        [string]$permissions.ServerLogin -cne $TargetUser -or
        [string]$permissions.DatabaseUser -cne $TargetUser) {
        throw "Connected target identity differs from server '$TargetServer', database '$TargetDatabase', and user '$TargetUser'."
    }

    $permissionExpectations = [ordered]@{
        db_datareader            = 1
        db_datawriter            = 0
        db_owner                 = 0
        db_ddladmin              = 0
        CreateTablePermission    = 0
        FlightsInsertPermission  = 0
        FlightsUpdatePermission  = 0
        FlightsDeletePermission  = 0
        FlightsAlterPermission   = 0
    }

    foreach ($permissionName in $permissionExpectations.Keys) {
        $actual = $permissions[$permissionName]
        $expected = $permissionExpectations[$permissionName]
        if ($null -eq $actual -or [int]$actual -ne $expected) {
            throw "Permission check failed: $permissionName expected $expected, received $actual."
        }
    }

    $command = $connection.CreateCommand()
    $command.CommandText = $sqlText
    $command.CommandTimeout = 180
    $reader = $command.ExecuteReader()

    $recordsets = [System.Collections.Generic.List[object]]::new()
    $offlineIssues = [System.Collections.Generic.List[object]]::new()

    do {
        $rows = [System.Collections.Generic.List[object]]::new()

        while ($reader.Read()) {
            $row = [ordered]@{}
            for ($field = 0; $field -lt $reader.FieldCount; $field++) {
                $name = $reader.GetName($field)
                $value = if ($reader.IsDBNull($field)) { $null } else { $reader.GetValue($field) }
                $row[$name] = Convert-SqlValueForReport -Value $value
            }

            if ((Get-RowSection -Row $row) -ceq 'V1_EVIDENCE') {
                $v1Summary.Total++
                $snapshot = $row['SnapshotJsonForOfflineVerification']
                [void]$row.Remove('SnapshotJsonForOfflineVerification')

                $calculatedHash = $null
                $utf8ByteLength = $null
                $hashMatches = $false
                $snapshotParsesAsObject = $false

                if ($snapshot -is [string]) {
                    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
                    $snapshotBytes = $utf8.GetBytes($snapshot)
                    $utf8ByteLength = $snapshotBytes.Length
                    $sha256 = [System.Security.Cryptography.SHA256]::Create()
                    try {
                        $hashBytes = $sha256.ComputeHash($snapshotBytes)
                        $calculatedHash = ([BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
                    }
                    finally {
                        $sha256.Dispose()
                        if ($null -ne $snapshotBytes) { [Array]::Clear($snapshotBytes, 0, $snapshotBytes.Length) }
                    }

                    $storedHash = [string]$row['RecordHash']
                    $hashMatches = $storedHash -match '^[A-Fa-f0-9]{64}$' -and
                        [StringComparer]::OrdinalIgnoreCase.Equals($calculatedHash, $storedHash)
                    $snapshotParsesAsObject = Test-JsonObject -Json $snapshot
                }

                $row['Utf8ByteLength'] = $utf8ByteLength
                $row['CalculatedRecordHash'] = $calculatedHash
                $row['HashMatches'] = $hashMatches
                $row['SnapshotParsesAsObject'] = $snapshotParsesAsObject

                if ($hashMatches -and $snapshotParsesAsObject) {
                    $v1Summary.Passed++
                }
                else {
                    $v1Summary.Failed++
                    $offlineIssues.Add([ordered]@{
                        Section = 'STOP_V1_OFFLINE_INTEGRITY'
                        ExportCompletionRecordId = $row['ExportCompletionRecordId']
                        FlightId = $row['FlightId']
                        HashMatches = $hashMatches
                        SnapshotParsesAsObject = $snapshotParsesAsObject
                    })
                }

                $snapshot = $null
            }

            $rows.Add($row)
        }

        $recordsets.Add($rows.ToArray())
    } while ($reader.NextResult())

    $reader.Dispose()
    $reader = $null
    $command.Dispose()
    $command = $null

    if ($offlineIssues.Count -gt 0) {
        $recordsets.Add($offlineIssues.ToArray())
    }

    $allRows = @($recordsets | ForEach-Object { @($_) })
    $staticRows = @($allRows | Where-Object {
        (Get-RowSection -Row $_) -ceq 'MIGRATION_STATIC_READINESS'
    })
    $requiredColumnRows = @($allRows | Where-Object {
        (Get-RowSection -Row $_) -ceq 'REQUIRED_COLUMN_COMPATIBILITY'
    })
    $stopRows = @($allRows | Where-Object {
        (Get-RowSection -Row $_).StartsWith('STOP_', [StringComparison]::Ordinal)
    })

    $staticSummary = @($staticRows | ForEach-Object {
        [ordered]@{ CheckName = $_['CheckName']; Result = $_['Result'] }
    })
    $stopSummary = @($stopRows | Group-Object { Get-RowSection -Row $_ } | ForEach-Object {
        [ordered]@{ Section = $_.Name; Count = $_.Count }
    })

    $staticFailed = $staticRows.Count -eq 0 -or
        @($staticRows | Where-Object { [string]$_['Result'] -cne 'PASS' }).Count -gt 0
    $columnFailed = $requiredColumnRows.Count -eq 0 -or
        @($requiredColumnRows | Where-Object { [string]$_['Result'] -cne 'PASS' }).Count -gt 0

    if ($staticFailed) {
        $stopSummary += [ordered]@{ Section = 'STOP_STATIC_READINESS'; Count = 1 }
    }
    if ($columnFailed) {
        $stopSummary += [ordered]@{ Section = 'STOP_REQUIRED_COLUMN_COMPATIBILITY'; Count = 1 }
    }
    $preflightClean = -not $staticFailed -and -not $columnFailed -and $stopRows.Count -eq 0 -and $v1Summary.Failed -eq 0

    $permissionReport = [ordered]@{}
    foreach ($permissionName in $permissionExpectations.Keys) {
        $permissionReport[$permissionName] = [int]$permissions[$permissionName]
    }

    $report = [ordered]@{
        Target = [ordered]@{
            Server = $TargetServer
            Database = $TargetDatabase
            User = $TargetUser
        }
        GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
        Permissions = $permissionReport
        StaticReadiness = $staticSummary
        V1Integrity = $v1Summary
        StopConditions = $stopSummary
        PreflightResult = if ($preflightClean) { 'CLEAN' } else { 'STOP' }
        Recordsets = $recordsets.ToArray()
    }

    Write-SanitizedReport -Report $report
}
catch {
    $failureMessage = $_.Exception.Message
    $failureReport = [ordered]@{
        Target = [ordered]@{
            Server = $TargetServer
            Database = $TargetDatabase
            User = $TargetUser
        }
        GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
        PreflightResult = 'STOP'
        Failure = $failureMessage
    }

    try { Write-SanitizedReport -Report $failureReport } catch {}
}
finally {
    if ($null -ne $reader) {
        try { $reader.Dispose() } catch {}
        $reader = $null
    }
    if ($null -ne $command) {
        try { $command.Dispose() } catch {}
        $command = $null
    }
    if ($null -ne $connection) {
        try {
            if ($connection.State -ne [System.Data.ConnectionState]::Closed) {
                $connection.Close()
            }
            $connection.ConnectionString = ''
            $connection.Dispose()
        }
        catch {}
        $connection = $null
    }
    if ($null -ne $connectionBuilder) {
        try {
            $connectionBuilder['Password'] = ''
            $connectionBuilder.Clear()
        }
        catch {}
        $connectionBuilder = $null
    }
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
        $passwordPointer = [IntPtr]::Zero
    }
    if ($null -ne $securePassword) {
        try { $securePassword.Dispose() } catch {}
        $securePassword = $null
    }
    $plainPassword = $null
    $connectionString = $null
}

Write-Output 'STATIC READINESS'
if ($failureMessage) {
    Write-Output '  NOT RUN'
}
elseif ($staticSummary.Count -eq 0) {
    Write-Output '  No readiness rows returned.'
}
else {
    foreach ($item in $staticSummary) {
        Write-Output "  $($item.CheckName): $($item.Result)"
    }
}

Write-Output 'V1 INTEGRITY'
if ($failureMessage) {
    Write-Output '  NOT RUN'
}
else {
    Write-Output "  Total: $($v1Summary.Total)"
    Write-Output "  Passed: $($v1Summary.Passed)"
    Write-Output "  Failed: $($v1Summary.Failed)"
}

Write-Output 'STOP CONDITIONS'
if ($failureMessage) {
    Write-Output "  PREFLIGHT_EXECUTION: $failureMessage"
}
elseif ($stopSummary.Count -eq 0) {
    Write-Output '  NONE'
}
else {
    foreach ($item in $stopSummary) {
        Write-Output "  $($item.Section): $($item.Count)"
    }
}

if ($failureMessage -or -not $preflightClean) {
    Write-Output 'PREFLIGHT RESULT: STOP'
    Write-Output "Sanitized report: $ReportPath"
    exit 1
}

Write-Output 'PREFLIGHT RESULT: CLEAN'
Write-Output "Sanitized report: $ReportPath"
exit 0





