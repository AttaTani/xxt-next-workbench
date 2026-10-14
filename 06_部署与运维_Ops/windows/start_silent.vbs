Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(currentDir))
ws.CurrentDirectory = projectRoot

cmdStr = "cmd /c set HTTP_PROXY=&set HTTPS_PROXY=&set ALL_PROXY=&set http_proxy=&set https_proxy=&set all_proxy=&node vps-service\web.js"
ws.Run cmdStr, 0, False
WScript.Sleep 2500
ws.Run "http://127.0.0.1:3888"
