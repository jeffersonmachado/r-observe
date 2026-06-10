#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d /tmp/infra-ci-hardened.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[release-ci-hardened] clean dist"
npm run dist:clean:release

echo "[release-ci-hardened] build prerequisites"
npm ci --prefer-offline --no-audit --no-fund
npm --prefix r-observe/discovery ci --prefer-offline --no-audit --no-fund


echo "[release-ci-hardened] tests and static checks"
npm --prefix r-observe/discovery test
bash scripts/discovery/discovery-lint.sh
bash scripts/discovery/discovery-audit.sh


echo "[release-ci-hardened] build zip artifacts"
npm run zip
npm run zip:release


echo "[release-ci-hardened] validate sha256 files"
for artifact in dist/infra.zip dist/infra-release.zip; do
  sha_file="${artifact}.sha256"
  [[ -f "$sha_file" ]] || { echo "sha ausente: $sha_file" >&2; exit 1; }
  grep -Eq '^[a-f0-9]{64}[[:space:]]{2}[^[:space:]]+$' "$sha_file" || { echo "sha formato invalido: $sha_file" >&2; exit 1; }
  (cd "$(dirname "$artifact")" && sha256sum -c "$(basename "$sha_file")")
done


echo "[release-ci-hardened] validate enterprise zip + extracted runtime"
npm run release:validate:enterprise


echo "[release-ci-hardened] anti-stale dist check"
node scripts/release/validate-enterprise-package.js --zip dist/infra.zip
node scripts/release/validate-enterprise-package.js --zip dist/infra-release.zip


echo "[release-ci-hardened] reproducibility check"
sha_infra_a="$(sha256sum dist/infra.zip | awk '{print $1}')"
sha_release_a="$(sha256sum dist/infra-release.zip | awk '{print $1}')"
manifest_infra_a="$(sha256sum dist/infra-manifest.txt dist/infra-manifest.json | sha256sum | awk '{print $1}')"
manifest_release_a="$(sha256sum dist/infra-release-manifest.txt dist/infra-release-manifest.json | sha256sum | awk '{print $1}')"

npm run zip
npm run zip:release

sha_infra_b="$(sha256sum dist/infra.zip | awk '{print $1}')"
sha_release_b="$(sha256sum dist/infra-release.zip | awk '{print $1}')"
manifest_infra_b="$(sha256sum dist/infra-manifest.txt dist/infra-manifest.json | sha256sum | awk '{print $1}')"
manifest_release_b="$(sha256sum dist/infra-release-manifest.txt dist/infra-release-manifest.json | sha256sum | awk '{print $1}')"

[[ "$sha_infra_a" == "$sha_infra_b" ]] || { echo "infra.zip nao reproduzivel" >&2; exit 1; }
[[ "$sha_release_a" == "$sha_release_b" ]] || { echo "infra-release.zip nao reproduzivel" >&2; exit 1; }
[[ "$manifest_infra_a" == "$manifest_infra_b" ]] || { echo "manifest infra nao reproduzivel" >&2; exit 1; }
[[ "$manifest_release_a" == "$manifest_release_b" ]] || { echo "manifest infra-release nao reproduzivel" >&2; exit 1; }


echo "[release-ci-hardened] OK"
