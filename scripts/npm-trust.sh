#!/bin/sh
# Sets the GitHub workflow release.yml of seams-tech/say-so as the trusted publisher of
# @seams/sayso-verdict and @seams/sayso-client on npm, so that the workflow can publish them with
# no npm token.
#
# npm trusts a workflow only for a package that exists, and it refuses a placeholder version such
# as 0.0.0-stage (403, 2026-11-27). So for a name that is not on npm yet, the script first
# publishes the release in the package.json files from this checkout. That release has no npm
# provenance; the workflow publishes every later version with provenance. The checkout must be a
# clean copy of origin/main.
#
# Run it in an interactive terminal, logged in to npm (`npm login`) with an account that can
# write the @seams scope. The first command asks for two-factor authentication in the browser. On
# that page, tick "Do not challenge npm publish, npm trust operations ... for the next 5 minutes":
# the other commands then run with no prompt.
#
# npm keeps one trusted publisher for each package. A package that trusts another workflow loses
# that relationship first.
set -eu

REPO=seams-tech/say-so
FILE=release.yml
PACKAGES="@seams/sayso-verdict @seams/sayso-client"
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/packages/sayso-verdict/package.json').version")
test "$(node -p "require('$root/packages/sayso-client/package.json').version")" = "$version"

npm whoami > /dev/null

missing=""
for package in $PACKAGES; do
  npm view "$package" name > /dev/null 2>&1 || missing="$missing $package"
done
if [ -n "$missing" ]; then
  git -C "$root" fetch --quiet origin main
  if [ -n "$(git -C "$root" status --porcelain)" ] || [ "$(git -C "$root" rev-parse HEAD)" != "$(git -C "$root" rev-parse origin/main)" ]; then
    echo "the first release must come from a clean copy of origin/main" >&2
    exit 1
  fi
  packs=$(mktemp -d)
  (cd "$root" && pnpm install --frozen-lockfile && pnpm build:packages)
  for package in $PACKAGES; do
    (cd "$root" && pnpm --filter "$package" pack --pack-destination "$packs")
  done
  # In dependency order: @seams/sayso-client depends on this version of @seams/sayso-verdict.
  for package in $missing; do
    tarball=$packs/$(echo "${package#@}" | tr / -)-$version.tgz
    echo "== publish the first release $package@$version"
    npm publish "$tarball" --access public
  done
  rm -rf "$packs"
  # A new package can take some minutes to show on the registry, and npm trusts only a package
  # that it shows.
  for package in $missing; do
    tries=0
    until npm view "$package@$version" version > /dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "$tries" -gt 60 ]; then
        echo "$package@$version is not on the registry after 10 minutes; run this script again" >&2
        exit 1
      fi
      sleep 10
    done
  done
fi

for package in $PACKAGES; do
  echo "== $package"
  existing=$(npm trust list "$package" --json 2>/dev/null || echo '[]')
  # The ids of the relationships that are not this workflow, and "same" if this workflow is
  # trusted already.
  state=$(printf '%s' "$existing" | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      let value;
      try { value = JSON.parse(text || "[]"); } catch { value = []; }
      const items = Array.isArray(value) ? value : (value.trustedPublishers ?? value.items ?? [value]);
      const out = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const file = item.file ?? item.claims?.workflow_ref?.file ?? item.workflow ?? "";
        const repo = item.repository ?? item.claims?.repository ?? "";
        if (String(file).endsWith(process.argv[1]) && (!repo || repo === process.argv[2])) out.push("same");
        else if (item.id) out.push(item.id);
      }
      console.log(out.join(" "));
    });
  ' "$FILE" "$REPO")
  case " $state " in
    *" same "*)
      echo "$package trusts $FILE already"
      continue
      ;;
  esac
  for id in $state; do
    echo "revoke the relationship $id"
    npm trust revoke --id "$id" "$package"
    sleep 2
  done
  npm trust github "$package" --file "$FILE" --repository "$REPO" --allow-publish --yes
  sleep 2
done

echo "== the trusted publishers now"
for package in $PACKAGES; do
  echo "$package:"
  npm trust list "$package"
done
