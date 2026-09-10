# Caching

The cache is stored in one SQLite database:

- Linux: `~/.cache/co-maintainer/cache.db`
- macOS: `~/Library/Caches/co-maintainer/cache.db`
- Windows: `%LOCALAPPDATA%\co-maintainer\cache.db`

Codebase files are keyed by path and Git tree SHA. The pull-request listing is
cached per repository and reused on the next `init`/`remake` until a newer
`updated_at` appears (then only the changed prefix is fetched). Discussions are
keyed by PR number and update time; diffs are keyed by PR number and head SHA.
AI jobs are keyed by their input and model profile, so unchanged work is reused
by `remake`.
