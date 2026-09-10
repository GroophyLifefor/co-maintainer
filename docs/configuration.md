# Configuration

Configuration is read from the platform user config path:

- Linux: `~/.config/co-maintainer/config.json`
- macOS: `~/Library/Application Support/co-maintainer/config.json`
- Windows: `%APPDATA%\co-maintainer\config.json`

CLI arguments take precedence over `--env=PATH`, then user config, then
interactive prompts and built-in defaults. An env file is loaded only when
`--env=PATH` is passed. Store defaults in config, not secrets. API keys should
come from CLI arguments or the env file.
