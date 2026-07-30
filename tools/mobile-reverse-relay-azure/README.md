# Orca mobile reverse relay

Deploy the gateway from PowerShell:

```powershell
.\deploy.ps1 -AppName orca-relay-<unique-name>
```

The command creates a free Linux App Service and prints the JSON expected at
`%APPDATA%\Orca\orca-mobile-relay.json`. Store that file with permissions limited to the
current user. Orca reads it at startup, advertises the public WSS endpoint in mobile pairing,
and keeps the desktop bridge connected until the app exits.

The gateway carries opaque Orca E2EE frames. Do not commit the generated route or secret.
