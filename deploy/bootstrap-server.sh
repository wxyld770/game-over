#!/usr/bin/env bash
# Run once as root on the game server, with this directory copied to /root/game-over-deploy.
set -euo pipefail
umask 022

[[ "${EUID}" -eq 0 ]] || { echo 'Run this setup as root.' >&2; exit 2; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
public_key="${script_dir}/github-actions.pub"
deploy_script="${script_dir}/deploy-game-over"
deploy_user=game-over-deploy
deploy_home=/var/lib/game-over-deploy
releases=/opt/game-over/releases
active=/opt/game-over/app

[[ -f "${public_key}" && ! -L "${public_key}" ]] || exit 2
[[ -f "${deploy_script}" && ! -L "${deploy_script}" ]] || exit 2
[[ "$(ssh-keygen -lf "${public_key}" -E sha256 | awk '{print $2}')" == \
   'SHA256:gGbG1PyuIEkBrFZJIPlr2LUajqZD92+EDeePM2Yazzo' ]] || exit 2
systemctl is-active --quiet game-over.service
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8889/api/health >/dev/null

if ! id "${deploy_user}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "${deploy_home}" --shell /bin/bash "${deploy_user}"
fi
passwd -l "${deploy_user}" >/dev/null
install -d -m 0700 -o "${deploy_user}" -g "${deploy_user}" "${deploy_home}" "${deploy_home}/.ssh" "${deploy_home}/incoming"
printf 'restrict %s\n' "$(cat "${public_key}")" > "${deploy_home}/.ssh/authorized_keys"
chown "${deploy_user}:${deploy_user}" "${deploy_home}/.ssh/authorized_keys"
chmod 0600 "${deploy_home}/.ssh/authorized_keys"

install -d -m 0755 -o root -g root "${releases}"
install -m 0755 -o root -g root "${deploy_script}" /usr/local/sbin/deploy-game-over

sudoers_tmp="$(mktemp)"
trap 'rm -f -- "${sudoers_tmp}"' EXIT
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/deploy-game-over\n' "${deploy_user}" > "${sudoers_tmp}"
chmod 0440 "${sudoers_tmp}"
visudo -cf "${sudoers_tmp}" >/dev/null
install -m 0440 -o root -g root "${sudoers_tmp}" /etc/sudoers.d/game-over-deploy
visudo -cf /etc/sudoers >/dev/null

if [[ -d "${active}" && ! -L "${active}" ]]; then
  prior="${releases}/pre-ci-$(date -u +%Y%m%d%H%M%S)"
  [[ ! -e "${prior}" ]] || exit 2
  mv -T -- "${active}" "${prior}"
  ln -s -- "${prior}" "${active}"
fi
[[ -L "${active}" && -d "$(readlink -f "${active}")" ]] || exit 2
systemctl is-active --quiet game-over.service
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8889/api/health >/dev/null
echo 'Game Over deploy account and release layout are ready.'
