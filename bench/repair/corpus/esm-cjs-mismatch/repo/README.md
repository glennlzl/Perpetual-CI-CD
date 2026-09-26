# config-loader

`loadConfig({ env })` reads `defaults.json` from the package and deep-merges overrides from environment variables:
`APP__SERVER__PORT=9000` sets `server.port` to `9000`. It works from any working directory.

2.0 publishes the package as an ES module.
