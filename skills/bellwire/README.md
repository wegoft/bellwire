<!-- SPDX-License-Identifier: Apache-2.0 -->

# Install the Bellwire Agent Skill

The Skill contains its own dependency-free CLI. It can target Bellwire Cloud
or a self-hosted API by setting `BELLWIRE_API_URL`.

## ClawHub

Install the published Skill:

```bash
clawhub install @xwchris/bellwire
```

The canonical listing is
[`xwchris/bellwire`](https://clawhub.ai/xwchris/skills/bellwire). ClawHub
installations can be refreshed with:

```bash
clawhub update @xwchris/bellwire
```

## Release archive

Each GitHub release includes a versioned `bellwire-skill-*.zip` archive and its
SHA-256 checksum. Download and extract the archive into the skills directory
used by your Agent:

```bash
gh release download --repo wegoft/bellwire --pattern 'bellwire-skill-*.zip*'
```

## Codex

Clone the repository and link the Skill into the personal Codex skills
directory:

```bash
git clone https://github.com/wegoft/bellwire.git
mkdir -p "$HOME/.codex/skills"
ln -s "$(pwd)/bellwire/skills/bellwire" "$HOME/.codex/skills/bellwire"
```

Restart Codex after installing the Skill. Open Bellwire on the iPhone, create a
one-time binding code, then ask Codex to use the Bellwire Skill to connect the
current repository.

If `bellwire` already exists in the skills directory, remove or rename that
specific old link before installing the new one. Do not recursively delete a
shared skills directory.

## Other compatible Agents

Copy or link the complete `skills/bellwire` directory into the Agent's personal
skills directory. The Agent must be able to read `SKILL.md`, `references/`, and
`scripts/` together.

The CLI can also be used directly without installing the Skill:

```bash
node skills/bellwire/scripts/bellwire.mjs --help
```

## Update

For the linked Codex installation, pull the repository with a fast-forward
update. The linked Skill updates immediately:

```bash
git -C bellwire pull --ff-only
```

Review the [five-minute quick start](../../docs/quickstart.md) for binding and
the first project/event flow.
