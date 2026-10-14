param(
    [string]$Title = "XueXiTong",
    [string]$Message = "Task update"
)

try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    
    $cleanTitle = [System.Security.SecurityElement]::Escape($Title)
    $cleanMessage = [System.Security.SecurityElement]::Escape($Message)

    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xmlString = "<toast><visual><binding template='ToastGeneric'><text>$cleanTitle</text><text>$cleanMessage</text></binding></visual></toast>"
    $xml.LoadXml($xmlString)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
}
