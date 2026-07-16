/**
 * `ab init` — vendor the canonical default skills into a repo (SPEC §16.3,
 * D11). Copies, not references: per-repo customization is the point, so each
 * skill lands in the harness-neutral `.agent/skills/ab-<name>/SKILL.md` where
 * the repo may edit it freely. Claude discovers the same skill through a
 * `.claude/skills/ab-<name>` symlink; there is only one editable copy.
 * Alongside the live copy, init records the PRISTINE installed bytes under
 * `.agent/skills/.ab-pristine/` — repo-versioned, the base of `ab upgrade`'s
 * three-way merges (src/cli/upgrade.ts).
 *
 * Init runs OUTSIDE build sessions: it takes a repo path, not a build, and
 * needs no AB_* environment. It is safe to re-run — an existing
 * autobuild.toml is never overwritten, and an installed skill with local
 * edits is never clobbered (`force: true` is the explicit human override).
 */
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { installedSkillName } from '../skills'

export { SKILL_NAMESPACE } from '../skills'

/** Harness-neutral home for vendored skills. */
export const AGENT_SKILLS_DIR = join('.agent', 'skills')

/** Claude-compatible discovery links point at the harness-neutral skills. */
export const CLAUDE_SKILLS_DIR = join('.claude', 'skills')

/** Where init records pristine installs, under `.agent/skills/`. */
export const PRISTINE_DIR = '.ab-pristine'

/**
 * The autobuild distribution root, resolved relative to THIS module file
 * (src/cli/init.ts → two levels up) so `ab init` works from any cwd. Its
 * `skills/` and `templates/` directories are the canonical source.
 */
export function defaultDistRoot(): string {
  return resolve(import.meta.dir, '..', '..')
}

/** Live install path: `<target>/.agent/skills/ab-<name>/SKILL.md`. */
export function installedSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, AGENT_SKILLS_DIR, installName, 'SKILL.md')
}

/** Claude discovery path: a directory symlink to the live `.agent` skill. */
export function claudeSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, CLAUDE_SKILLS_DIR, installName)
}

/** Pristine record: `<target>/.agent/skills/.ab-pristine/ab-<name>/SKILL.md`. */
export function pristineSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, AGENT_SKILLS_DIR, PRISTINE_DIR, installName, 'SKILL.md')
}

function legacyInstalledSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, CLAUDE_SKILLS_DIR, installName, 'SKILL.md')
}

function legacyPristineSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, CLAUDE_SKILLS_DIR, PRISTINE_DIR, installName, 'SKILL.md')
}

/** Read a file's text, or undefined when it does not exist. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Rewrite a canonical skill's YAML frontmatter for installation (§16.3):
 * `name` becomes the namespaced `ab-<name>`, and every skill EXCEPT `spec`
 * gets `disable-model-invocation: true` — phase skills are invoked explicitly
 * by the runner or a human, never auto-triggered by a model pattern-matching
 * a description. The description and the body below the frontmatter are
 * preserved verbatim. Deliberately minimal and line-based: two known keys do
 * not justify a YAML dependency.
 */
export function rewriteSkillSource(source: string, skillName: string): string {
  const lines = source.split('\n')
  if (lines[0] !== '---') {
    throw new Error(
      `skill "${skillName}" has no YAML frontmatter — expected the file to open with '---'`,
    )
  }
  const close = lines.indexOf('---', 1)
  if (close === -1) {
    throw new Error(
      `skill "${skillName}" has unterminated YAML frontmatter — no closing '---' found`,
    )
  }
  const front = lines
    .slice(1, close)
    .filter((line) => !line.startsWith('disable-model-invocation:'))
    .map((line) =>
      line.startsWith('name:') ? `name: ${installedSkillName(skillName)}` : line,
    )
  if (skillName !== 'spec') front.push('disable-model-invocation: true')
  return ['---', ...front, ...lines.slice(close)].join('\n')
}

export interface DistSkill {
  /** Bare name in the distribution (`plan`). */
  name: string
  /** Namespaced install name (`ab-plan`). */
  installName: string
  /** Install content: the source with its frontmatter rewritten (§16.3). */
  content: string
}

/** Enumerate `<distRoot>/skills/<name>/SKILL.md`, sorted, install-ready. */
export async function readDistSkills(distRoot: string): Promise<DistSkill[]> {
  const skillsDir = join(distRoot, 'skills')
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const skills: DistSkill[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const source = await readIfExists(join(skillsDir, entry.name, 'SKILL.md'))
    if (source === undefined) continue
    skills.push({
      name: entry.name,
      installName: installedSkillName(entry.name),
      content: rewriteSkillSource(source, entry.name),
    })
  }
  return skills
}

/** Ensure Claude discovers the canonical `.agent` skill through a symlink. */
export async function ensureClaudeSkillLink(
  targetRepo: string,
  installName: string,
): Promise<void> {
  const link = claudeSkillPath(targetRepo, installName)
  const target = dirname(installedSkillPath(targetRepo, installName))
  await mkdir(dirname(link), { recursive: true })

  try {
    const stat = await lstat(link)
    if (stat.isSymbolicLink()) {
      const current = resolve(dirname(link), await readlink(link))
      if (current === resolve(target)) return
      await unlink(link)
    } else {
      throw new Error(
        `cannot create Claude link for "${installName}": ${CLAUDE_SKILLS_DIR}/${installName} ` +
          `is a real directory while ${AGENT_SKILLS_DIR}/${installName} already exists`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await symlink(relative(dirname(link), target), link, 'dir')
}

/**
 * Move a pre-neutral-layout `.claude` install into `.agent` without losing
 * local edits or the pristine merge base. Returns the migrated live bytes.
 */
export async function migrateLegacySkill(
  targetRepo: string,
  installName: string,
): Promise<string | undefined> {
  if ((await readIfExists(installedSkillPath(targetRepo, installName))) !== undefined) {
    return undefined
  }
  const legacy = await readIfExists(legacyInstalledSkillPath(targetRepo, installName))
  if (legacy === undefined) return undefined

  const legacyDir = dirname(legacyInstalledSkillPath(targetRepo, installName))
  const live = installedSkillPath(targetRepo, installName)
  await mkdir(dirname(dirname(live)), { recursive: true })
  await cp(legacyDir, dirname(live), { recursive: true })
  const legacyPristine = await readIfExists(legacyPristineSkillPath(targetRepo, installName))
  if (legacyPristine !== undefined) {
    await writePristine(targetRepo, installName, legacyPristine)
  }
  // The complete directory now lives under `.agent`; clear the old discovery
  // location so ensureClaudeSkillLink can replace it without discarding data.
  await rm(legacyDir, { recursive: true, force: true })
  return legacy
}

/** Write a skill's live copy, pristine record, and Claude discovery link. */
export async function installSkillFiles(
  targetRepo: string,
  installName: string,
  content: string,
): Promise<void> {
  const live = installedSkillPath(targetRepo, installName)
  await mkdir(dirname(live), { recursive: true })
  await writeFile(live, content)
  await writePristine(targetRepo, installName, content)
  await ensureClaudeSkillLink(targetRepo, installName)
}

/** Update only the pristine record for a skill. */
export async function writePristine(
  targetRepo: string,
  installName: string,
  content: string,
): Promise<void> {
  const pristine = pristineSkillPath(targetRepo, installName)
  await mkdir(dirname(pristine), { recursive: true })
  await writeFile(pristine, content)
}

export type InitSkillAction = 'installed' | 'kept' | 'unchanged' | 'overwritten'
export type InitConfigAction = 'written' | 'skipped'

export interface InitReport {
  /** What happened to autobuild.toml. */
  config: InitConfigAction
  /** Per-skill outcome, keyed by the namespaced install name. */
  skills: Array<{ skill: string; action: InitSkillAction }>
}

export async function abInit(opts: {
  targetRepo: string
  distRoot?: string
  stdout?: (line: string) => void
  force?: boolean
}): Promise<InitReport> {
  const distRoot = opts.distRoot ?? defaultDistRoot()
  const stdout = opts.stdout ?? (() => {})
  const force = opts.force ?? false

  // autobuild.toml from the template — never overwrite an existing one
  // (§16.3): the repo's config is the repo's, from the very first re-run.
  const configPath = join(opts.targetRepo, 'autobuild.toml')
  let config: InitConfigAction
  if ((await readIfExists(configPath)) === undefined) {
    const template = await readFile(join(distRoot, 'templates', 'autobuild.toml'), 'utf8')
    await mkdir(opts.targetRepo, { recursive: true })
    await writeFile(configPath, template)
    config = 'written'
  } else {
    config = 'skipped'
  }
  stdout(`autobuild.toml: ${config}`)

  const skills: InitReport['skills'] = []
  for (const skill of await readDistSkills(distRoot)) {
    const migrated = await migrateLegacySkill(opts.targetRepo, skill.installName)
    const local =
      migrated ?? (await readIfExists(installedSkillPath(opts.targetRepo, skill.installName)))
    let action: InitSkillAction
    if (local === undefined) {
      await installSkillFiles(opts.targetRepo, skill.installName, skill.content)
      action = 'installed'
    } else if (local === skill.content) {
      // Byte-identical to what init would write. Refreshing the pristine
      // record is safe here — local == new default means there is no local
      // divergence a future merge could need the old base for — and it
      // self-heals a missing record.
      await writePristine(opts.targetRepo, skill.installName, skill.content)
      action = 'unchanged'
    } else if (force) {
      await installSkillFiles(opts.targetRepo, skill.installName, skill.content)
      action = 'overwritten'
    } else {
      // Local edits are NEVER clobbered by init (§16.3) — upgrading an
      // edited skill is `ab upgrade`'s three-way-merge job, not init's.
      action = 'kept'
    }
    await ensureClaudeSkillLink(opts.targetRepo, skill.installName)
    stdout(`${skill.installName}: ${action}`)
    skills.push({ skill: skill.installName, action })
  }
  return { config, skills }
}
