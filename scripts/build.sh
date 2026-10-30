#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
assets="$(python3 "${root}/scripts/prepare-build.py")"
mkdir -p "${root}/dist/toolchain/bin" "${root}/dist/builds"
c2w="${root}/dist/toolchain/bin/c2w-$(basename "${assets}")"
go_executable="${GO:-go}"
# c2w embeds its Dockerfile at compile time. Pass both overrides below so the
# selected Dockerfile and its Go/kernel/config assets always match our patch.
if [[ ! -x "${c2w}" ]]; then
  ( cd "${assets}" && "${go_executable}" build -trimpath -o "${c2w}" ./cmd/c2w )
fi

image="${WEB_IDE_IMAGE:-web-ide:local}"
guest="${WEB_IDE_GUEST_IMAGE:-web-ide-guest:local}"
code_version="$(awk -F= '/^ARG CODE_SERVER_VERSION=/{print $2; exit}' "${root}/guest/Dockerfile")"
[[ -n "${code_version}" ]] || { echo "CODE_SERVER_VERSION is missing" >&2; exit 1; }
docker build --platform linux/amd64 -t "${guest}" "${root}/guest"
guest_id="$(docker image inspect "${guest}" --format '{{.Id}}')"
# A content-derived local tag keeps all three consumers on exactly this image,
# even if another build later moves the convenient :local tag.
guest_ref="web-ide-guest:build-${guest_id#sha256:}"
docker image tag "${guest_id}" "${guest_ref}"

output="$(mktemp -d "${root}/dist/builds/browser-XXXXXX")/htdocs"
mkdir -p "${output}"
"${c2w}" --to-js \
  --dockerfile "${assets}/Dockerfile" \
  --assets "${assets}" \
  --build-arg VM_MEMORY_SIZE_MB=1024 \
  --build-arg QEMU_MIGRATION=true \
  "${guest_ref}" "${output}/"
python3 "${root}/scripts/verify-vm-assets.py" "${output}" "${guest_id}" "${assets}"
docker build --platform "${WEB_IDE_PLATFORM:-linux/amd64}" -f "${root}/nginx/Dockerfile" \
  --build-context "vm-assets=${output}" \
  --build-arg "GUEST_IMAGE=${guest_ref}" \
  --build-arg "CODE_SERVER_VERSION=${code_version}" \
  -t "${image}" "${root}"
echo "Built ${image} from guest ${guest_id}."
echo "Verified VM assets: ${output}"
