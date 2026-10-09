# Static SDK platform adapter. Requests are data on stdin, never executable text.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$contract = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-task-scheduler-contract.json') -Raw | ConvertFrom-Json
$request = $null
$service = $null
$folder = $null
$currentIdentity = $null
$currentSid = $null

function Fail([string]$category) {
    $errorValue = New-Object System.InvalidOperationException('SDK task operation failed')
    $errorValue.Data['sdk_category'] = $category
    throw $errorValue
}
function HashText([string]$value) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant()) }
    finally { $hasher.Dispose() }
}
function HResult($exception) {
    $cause = $exception
    for ($i = 0; $i -lt 4 -and $null -ne $cause.InnerException; $i++) { $cause = $cause.InnerException }
    return [long](([long]$cause.HResult + 4294967296L) % 4294967296L)
}
function ValidateFields($value, [string[]]$expected) {
    $names = @($value.PSObject.Properties.Name)
    if ($names.Count -ne $expected.Count) { Fail 'invalid_request' }
    foreach ($name in $names) { if ($expected -notcontains $name) { Fail 'invalid_request' } }
}
function ValidateXml([string]$xml) {
    if ([string]::IsNullOrEmpty($xml) -or [Text.Encoding]::UTF8.GetByteCount($xml) -gt $contract.bounds.definition_utf8_bytes) { Fail 'invalid_request' }
    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create((New-Object System.IO.StringReader($xml)), $settings)
    try {
        $document = New-Object System.Xml.XmlDocument
        $document.XmlResolver = $null
        $document.Load($reader)
        if ($document.DocumentElement.LocalName -ne 'Task' -or $document.DocumentElement.NamespaceURI -ne 'http://schemas.microsoft.com/windows/2004/02/mit/task') { Fail 'invalid_request' }
    } finally { $reader.Dispose() }
}
function ResolveUserSid([string]$user) {
    # Task Scheduler canonicalizes a SID to an account-name representation.
    # Resolve that representation through Windows rather than guessing aliases.
    try {
        if ($user -match '^S-\d(?:-\d+)+$') {
            $resolved = New-Object Security.Principal.SecurityIdentifier($user)
        } else {
            $account = New-Object Security.Principal.NTAccount($user)
            $resolved = $account.Translate([Security.Principal.SecurityIdentifier])
        }
        return $resolved.Value
    } catch { Fail 'unsupported_principal' }
}
function VerifyPrincipal($definition) {
    $user = ResolveUserSid ([string]$definition.Principal.UserId)
    if ($user -ne $currentSid -or $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Type -ne 0) { Fail 'unsupported_principal' }
    return [ordered]@{ current_user_sid=$currentSid; user_sid=$user; logon_type=3; run_level=0 }
}
function NewDefinition([string]$xml) {
    ValidateXml $xml
    $definition = $service.NewTask(0)
    $definition.XmlText = $xml
    $null = VerifyPrincipal $definition
    $definition.Principal.UserId = $currentSid
    # Explicit logon users have the same SID/account representation rule.
    # Empty means any user and must never acquire the current principal.
    for ($i=1; $i -le $definition.Triggers.Count; $i++) {
        $trigger = $definition.Triggers.Item($i)
        if ($trigger.Type -eq 9 -and -not [string]::IsNullOrEmpty([string]$trigger.UserId)) {
            $trigger.UserId = ResolveUserSid ([string]$trigger.UserId)
        }
    }
    if (-not [string]::IsNullOrEmpty($definition.RegistrationInfo.URI) -and $definition.RegistrationInfo.URI -ne $request.task_path) { Fail 'identity_mismatch' }
    $definition.RegistrationInfo.URI = $request.task_path
    return $definition
}
function SameDefinition([string]$actual, $desired) {
    $normalized = NewDefinition $actual
    # XmlText is reformatted by registration. Remove inter-element formatting
    # only; leaf text (including whitespace-only action arguments) is authority.
    $left = New-Object Xml.XmlDocument
    $right = New-Object Xml.XmlDocument
    $left.XmlResolver = $null; $right.XmlResolver = $null
    $left.PreserveWhitespace = $true; $right.PreserveWhitespace = $true
    $left.LoadXml($normalized.XmlText); $right.LoadXml($desired.XmlText)
    foreach ($document in @($left, $right)) {
        foreach ($node in @($document.SelectNodes('//*'))) {
            if (@($node.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element }).Count -gt 0) {
                foreach ($child in @($node.ChildNodes)) {
                    if ($child.NodeType -eq [Xml.XmlNodeType]::Whitespace) { $null = $node.RemoveChild($child) }
                }
            }
        }
    }
    return [string]::Equals($left.DocumentElement.OuterXml, $right.DocumentElement.OuterXml, [StringComparison]::Ordinal)
}
function GetTask {
    try { return $folder.GetTask($request.task_path.Substring(1)) }
    catch {
        $code = HResult $_.Exception
        if ($code -eq 2147942402L -or $code -eq 2147750671L) { return $null }
        throw
    }
}
function Instances($task) {
    # GetInstances(0) may omit Hidden tasks even at the admitted current-user
    # privilege. GetRunningTasks(1) explicitly includes hidden instances.
    # Observe verifies the selected principal before this enumeration. Foreign
    # entries contribute only their Path to the exact selected-task filter.
    $selectedPath = [string]$task.Path
    if (-not [string]::Equals($selectedPath, [string]$request.task_path, [StringComparison]::OrdinalIgnoreCase)) { Fail 'identity_mismatch' }
    $collection = $service.GetRunningTasks(1)
    $count = $collection.Count
    if ($count -lt 0 -or $count -gt $contract.bounds.maximum_running_tasks_inspected) { Fail 'output_limit' }
    $result = @()
    $seen = @{}
    for ($i=1; $i -le $count; $i++) {
        $item = $collection.Item($i)
        if (-not [string]::Equals([string]$item.Path, $selectedPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($result.Count -ge $contract.bounds.maximum_instances) { Fail 'output_limit' }
        $id = ([guid]$item.InstanceGuid).ToString('B').ToUpperInvariant()
        if ($id -eq [guid]::Empty.ToString('B').ToUpperInvariant() -or $seen.ContainsKey($id)) { Fail 'instance_mismatch' }
        $seen[$id] = $true
        $result += @{ id=$id; instance=$item }
    }
    return ,$result
}
function Observe($task) {
    if ($null -eq $task) {
        return [ordered]@{ registered=$false; enabled=$null; definition_xml=$null; definition_sha256=$null; instance_guids=@(); principal=$null; action=$null }
    }
    # All definition-owned facts come from this one captured definition.
    $definition = $task.Definition
    $principal = VerifyPrincipal $definition
    $xml = [string]$definition.XmlText
    ValidateXml $xml
    $exec = $definition.Actions.Item(1)
    $action = [ordered]@{ command=[string]$exec.Path; arguments=[string]$exec.Arguments;
        working_directory=[string]$exec.WorkingDirectory }
    $encoder = New-Object Text.UTF8Encoding($false, $true)
    foreach ($field in $contract.action_fields) {
        if ($action[$field].Length -gt $contract.bounds.action_field_utf16_units) { Fail 'output_limit' }
        $null = $encoder.GetByteCount($action[$field])
    }
    if ([string]::IsNullOrEmpty($action.command)) { Fail 'identity_mismatch' }
    $instances = Instances $task
    return [ordered]@{ registered=$true; enabled=[bool]$definition.Settings.Enabled; definition_xml=$xml;
        definition_sha256=(HashText $xml); instance_guids=@($instances | ForEach-Object { $_.id }); principal=$principal; action=$action }
}
function ExpectedMatches($observation) {
    if ($null -eq $request.expected_xml_sha256) { return -not $observation.registered }
    return $observation.registered -and $observation.definition_sha256 -eq $request.expected_xml_sha256
}

try {
    # Bound stdin independently of the JavaScript caller; do not ReadToEnd on an
    # untrusted stream. UTF-16 character bound is conservative for this UTF-8 cap.
    $inputBuilder = New-Object Text.StringBuilder
    $buffer = New-Object char[] 4096
    while (($read = [Console]::In.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($inputBuilder.Length + $read -gt $contract.bounds.request_bytes) { Fail 'invalid_request' }
        $null = $inputBuilder.Append($buffer, 0, $read)
    }
    $text = $inputBuilder.ToString()
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt $contract.bounds.request_bytes) { Fail 'invalid_request' }
    $request = $text | ConvertFrom-Json
    $fieldMap = @{
        inspect=@(); set_enabled=@('expected_definition_xml','expected_xml_sha256','enabled');
        stop_instances=@('expected_definition_xml','expected_xml_sha256','instance_guids');
        register=@('expected_definition_xml','expected_xml_sha256','definition_xml');
        delete=@('expected_definition_xml','expected_xml_sha256'); run=@('expected_definition_xml','expected_xml_sha256')
    }
    if ($null -eq $request -or $fieldMap.Keys -notcontains $request.operation) { Fail 'invalid_request' }
    ValidateFields $request (@('schema','schema_version','operation','task_path') + $fieldMap[$request.operation])
    if ($request.schema -ne $contract.request_schema -or $request.schema_version -ne 1 -or
        $request.task_path -isnot [string] -or $request.task_path.Length -gt $contract.bounds.task_path_utf16_units -or
        $request.task_path -notmatch '^\\[^\\/\x00-\x1f]+$') { Fail 'invalid_request' }
    if ($request.operation -ne 'inspect') {
        $absent = @('register','delete') -contains $request.operation -and $null -eq $request.expected_xml_sha256 -and $null -eq $request.expected_definition_xml
        if (-not $absent) {
            ValidateXml $request.expected_definition_xml
            if ($request.expected_xml_sha256 -isnot [string] -or $request.expected_xml_sha256 -notmatch '^[0-9a-f]{64}$' -or
                (HashText $request.expected_definition_xml) -ne $request.expected_xml_sha256) { Fail 'invalid_request' }
        }
    }
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $currentIdentity.User.Value
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $folder = $service.GetFolder('\')
    $task = GetTask
    $before = Observe $task
    switch ($request.operation) {
        inspect { }
        set_enabled {
            if ($request.enabled -isnot [bool]) { Fail 'invalid_request' }
            $desired = NewDefinition $request.expected_definition_xml
            $desired.Settings.Enabled = $request.enabled
            $already = $before.registered -and $before.enabled -eq $request.enabled -and (SameDefinition $before.definition_xml $desired)
            if (-not $already) {
                if (-not (ExpectedMatches $before)) { Fail 'identity_mismatch' }
                $task.Enabled = $request.enabled
            }
        }
        stop_instances {
            if ($request.instance_guids -isnot [array] -or $request.instance_guids.Count -gt $contract.bounds.maximum_instances) { Fail 'invalid_request' }
            $seen = @{}
            foreach ($id in $request.instance_guids) {
                if ($id -isnot [string] -or $id -cnotmatch '^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$' -or $seen.ContainsKey($id)) { Fail 'invalid_request' }
                $seen[$id] = $true
            }
            if (-not (ExpectedMatches $before)) { Fail 'identity_mismatch' }
            $instances = Instances $task
            foreach ($item in $instances) { if ($request.instance_guids -cnotcontains $item.id) { Fail 'instance_mismatch' } }
            foreach ($item in $instances) { $item.instance.Stop() }
        }
        register {
            $desired = NewDefinition $request.definition_xml
            $already = $before.registered -and (SameDefinition $before.definition_xml $desired)
            if (-not $already) {
                if (-not (ExpectedMatches $before)) { Fail 'identity_mismatch' }
                # CREATE_OR_UPDATE | IGNORE_REGISTRATION_TRIGGERS: restoring an
                # inactive before-state must not implicitly launch its action.
                $task = $folder.RegisterTaskDefinition($request.task_path.Substring(1), $desired, $contract.registration_flags, $currentSid, $null, 3, $null)
            }
        }
        delete {
            if ($before.registered) {
                if (-not (ExpectedMatches $before)) { Fail 'identity_mismatch' }
                if ($before.instance_guids.Count -ne 0) { Fail 'instance_mismatch' }
                $folder.DeleteTask($request.task_path.Substring(1), 0)
            }
        }
        run {
            if (-not (ExpectedMatches $before)) { Fail 'identity_mismatch' }
            if (-not $before.enabled) { Fail 'identity_mismatch' }
            if ($before.instance_guids.Count -eq 0) { $null = $task.Run($null) }
        }
    }
    $after = Observe (GetTask)
    if ($request.operation -eq 'set_enabled' -and (-not $after.registered -or $after.enabled -ne $request.enabled -or -not (SameDefinition $after.definition_xml $desired))) { Fail 'identity_mismatch' }
    if ($request.operation -eq 'register' -and (-not $after.registered -or -not (SameDefinition $after.definition_xml $desired))) { Fail 'identity_mismatch' }
    if ($request.operation -eq 'delete' -and $after.registered) { Fail 'identity_mismatch' }
    if ($request.operation -eq 'run' -and (-not $after.registered -or -not $after.enabled -or $after.definition_sha256 -ne $request.expected_xml_sha256)) { Fail 'identity_mismatch' }
    if ($request.operation -eq 'stop_instances') {
        foreach ($id in $after.instance_guids) { if ($request.instance_guids -ccontains $id) { Fail 'instance_mismatch' } }
    }
    $result = [ordered]@{ schema=$contract.result_schema; schema_version=1; operation=$request.operation;
        task_path=$request.task_path; outcome='completed'; observation=$after; failure=$null }
    $exitCode = 0
} catch {
    $category = 'platform_failure'
    $cause = $_.Exception
    for ($i=0; $i -lt 4; $i++) {
        if ($cause.Data.Contains('sdk_category')) { $category = [string]$cause.Data['sdk_category']; break }
        if ($null -eq $cause.InnerException) { break }
        $cause = $cause.InnerException
    }
    $operation = 'inspect'; $taskPath = '\invalid'
    if ($null -ne $request) {
        if ($request.PSObject.Properties.Name -contains 'operation') { $operation = $request.operation }
        if ($request.PSObject.Properties.Name -contains 'task_path') { $taskPath = $request.task_path }
    }
    $result = [ordered]@{ schema=$contract.result_schema; schema_version=1; operation=$operation;
        task_path=$taskPath; outcome='failed'; observation=$null;
        failure=[ordered]@{ category=$category; hresult=(HResult $_.Exception) } }
    $exitCode = 1
} finally {
    if ($null -ne $folder) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($folder) }
    if ($null -ne $service) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($service) }
    if ($null -ne $currentIdentity) { $currentIdentity.Dispose() }
}
[Console]::Out.Write(($result | ConvertTo-Json -Depth 8 -Compress))
exit $exitCode
