#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$ROOT_DIR/ops/ansible"
INVENTORY_FILE="$ANSIBLE_DIR/inventory/local/hosts.yml"
VARS_FILE="$ANSIBLE_DIR/group_vars/all.local.yml"
PLAYBOOK_FILE="$ANSIBLE_DIR/playbooks/relay.yml"

if ! command -v ansible-playbook >/dev/null 2>&1; then
  echo "ansible-playbook is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -f "$VARS_FILE" ]]; then
  echo "Missing vars file: $VARS_FILE" >&2
  exit 1
fi

exec ansible-playbook \
  -i "$INVENTORY_FILE" \
  -e @"$VARS_FILE" \
  "$PLAYBOOK_FILE" \
  "$@"
