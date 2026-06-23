# Changelog

Release notes for **AI Interview Assistant**, one file per version, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/).

| Version | Date | Highlights |
| --- | --- | --- |
| [0.2.0](./0.2.0.md) | 2026-06-23 | System tray, configurable global shortcuts, animated logo |
| [0.1.0](./0.1.0.md) | 2026-06 | Initial scaffold: live session, overlay, profiles, mock, reports |

## How to add a release

1. Copy the structure of the latest version file into `changelog/<version>.md`.
2. Group changes under **Added**, **Changed**, **Fixed**, **Removed**, or **Security**.
3. Bump `version` in `package.json` to match the file name.
4. Add a row to the table above (newest first).

Each entry should be written for a user reading "What's new", not a raw git log —
describe the behavior change, not the implementation.
