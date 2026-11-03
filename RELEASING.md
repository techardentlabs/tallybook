# Releasing TallyBook

## Versioning

TallyBook uses [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, optionally with a pre-release suffix.

| Change | Bump | Example |
|---|---|---|
| Data format change that needs a migration users cannot undo, or removal of a feature | MAJOR | 1.4.2 → 2.0.0 |
| New features, new reports, new masters (backward compatible; schema changes are additive migrations) | MINOR | 1.4.2 → 1.5.0 |
| Bug fixes, layout fixes, wording | PATCH | 1.4.2 → 1.4.3 |
| Test builds | pre-release | 1.5.0-beta.1, 1.5.0-rc.1 |

While the version is `0.x`, minor releases may change behaviour; we still never ship a migration that loses data.

The version lives in five files kept in sync by one command:

```sh
pnpm run version:patch        # or version:minor / version:major
node scripts/version.mjs 1.5.0-beta.1   # explicit version
pnpm run version              # print the current version
```

It updates the three `package.json` files, `tauri.conf.json`, `Cargo.toml`, and adds a dated heading to `CHANGELOG.md` under `[Unreleased]`.

## Update cycle

| Channel | Tag | Cadence | Who gets it |
|---|---|---|---|
| Stable | `vX.Y.Z` | Minor release on the first Monday of every month; patch releases as needed (within 48 hours for data or GST issues) | Everyone, through the in-app updater and tallybook.online |
| Pre-release | `vX.Y.Z-beta.N`, `-rc.N` | Weekly during a cycle | Marked "pre-release" on GitHub; not offered by the updater |

Monthly cycle:

1. Weeks 1–3: features land on `main` behind passing CI. Each change adds a line under `[Unreleased]` in `CHANGELOG.md`.
2. Week 3: tag `vX.Y.0-rc.1`, install it on all three platforms, run through the release checklist below.
3. First Monday: bump to `X.Y.0`, tag, publish.
4. Statutory changes (GST rates, TDS rates, return formats) ship as a patch as soon as they are notified, not at the monthly release.

## How a release is built

1. `pnpm run version:minor` (or patch/major), move the `[Unreleased]` notes under the new heading, commit to `main`.
2. `git push origin main`. Pushing a new version in `tauri.conf.json` is all it takes; no manual tag is needed.
3. The **Release** workflow sees a version that has no release yet, creates the `vX.Y.Z` tag and a draft release from the changelog section, builds on macOS (universal), Windows and Linux in parallel, uploads the installers and the signed updater files plus `latest.json`, then publishes the release.
4. Installed apps check `https://github.com/techardentlabs/tallybook/releases/latest/download/latest.json` four seconds after start-up; users can also press F1 then Alt+U. Updates are verified against the public key in `tauri.conf.json` before they install.
5. tallybook.online reads the latest release from the GitHub API, so its download buttons update automatically.

Artifacts per release:

| Platform | Installers | Updater payload |
|---|---|---|
| macOS (Apple Silicon + Intel) | `.dmg` | `.app.tar.gz` + `.sig` |
| Windows | `.msi`, `-setup.exe` | same files + `.sig` |
| Linux | `.AppImage`, `.deb`, `.rpm` | `.AppImage` + `.sig` |

## Secrets

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Signs update packages. The key file lives outside the repo (`~/.tauri/tallybook.key`). Back it up: if it is lost, installed apps can no longer be updated. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty for the current key. |

### macOS signing and notarisation

The Release workflow signs and notarises the Mac build automatically once these secrets exist on `techardentlabs/tallybook`; without them it builds unsigned.

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Base64 of the exported "Developer ID Application" certificate (.p12): `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | Password chosen when exporting the .p12 |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Techardent Internet Private Limited (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect → Users and Access → Integrations → Keys: Issuer ID |
| `APPLE_API_KEY` | Key ID of an API key with the Developer role |
| `APPLE_API_PRIVATE_KEY` | Contents of the downloaded `AuthKey_<KEYID>.p8` |

Enrol as an Organisation (Techardent Internet Private Limited, needs a D-U-N-S number) so the certificate shows the company name, not a person's.

Windows signing is not set up yet; Azure Trusted Signing or an OV/EV certificate removes the SmartScreen warning.

## Release checklist

- [ ] `pnpm test` and both typechecks pass (CI is green).
- [ ] Install the rc on macOS, Windows and Linux; open an existing company created by the previous version and confirm the data migrated.
- [ ] Create a company, post one voucher of each type, open Balance Sheet, P&L, Trial Balance, GSTR-1.
- [ ] Import a Tally XML export; re-import it and confirm no duplicates.
- [ ] Backup, restore into a new company, compare Trial Balance.
- [ ] Update from the previous release through the in-app updater.

## Website

The tallybook.online site lives in `techardentlabs/tallybook-releases` (`site/`), deployed to GitHub Pages by its **Website** workflow. It reads the latest release of `techardentlabs/tallybook` from the GitHub API. The custom domain is `tallybook.online`.

You can also run the **Release** workflow by hand from the Actions tab; it does nothing if the current version is already released.
