import fs from 'fs'
import { setOutput, getInput, getBooleanInput, getMultilineInput } from '@actions/core'
import convBump from 'conventional-recommended-bump'
import { inc } from 'semver'
import { join } from 'path'
import { execSync } from 'child_process'

const DRY = !process.env.CI;

interface Note {
    title: string;
    text: string;
}

interface Reference {
    issue: string;

    /**
     * @default
     * null
     */
    action?: string;

    /**
     * @default
     * null
     */
    owner?: string;

    /**
     * @default
     * null
     */
    repository?: string;

    prefix: string;
    raw: string;
}

interface Revert {
    hash?: string;
    header?: string;
    [field: string]: string | undefined;
}

interface CommitBase {
    merge?: string;

    header?: string;

    body?: string;

    footer?: string;

    notes: Note[];

    references: Reference[];

    mentions: string[];
    revert?: Revert;

    type?: string;
    scope?: string;
    subject?: string;
}

interface PackageData {
    packageDir: string
    packageJsonPath: string
    packageJson: any
}

interface Reasons {
    breakings: CommitBase[]
    feats: CommitBase[]
    fixes: CommitBase[]
    deps: { name: string; releaseType: string }[]
}

interface PackageUpdate extends PackageData {
    newVersion: string
    bumpLevel: number
    reasons: Reasons
}

const remote = execSync('git config --get remote.origin.url').toString().trim()

async function getBumpSuggestion(path: string) {
    const result = await new Promise<convBump.Callback.Recommendation & { reasons: Reasons }>((resolve, reject) => {
        convBump({
            path,
            whatBump(comments) {
                const feats = comments.filter(c => c.type === 'feat')
                const fixes = comments.filter(c => c.type === 'fix' || c.type === 'refactor')
                const breakings = comments.filter(c => c.header?.startsWith('BREAKING CHANGE:'))
                if (comments.some(c => c.header?.startsWith('BREAKING CHANGE:'))) {
                    return { level: 0, reasons: { feats, fixes, breakings, deps: [] }, feats, fixes, breakings } // major
                } else if (comments.some(c => c.type === 'feat')) {
                    return { level: 1, reasons: { feats, fixes, breakings, deps: [] }, feats, fixes, breakings } // minor
                } else if (comments.some(c => c.type === 'fix' || c.type === 'refactor')) {
                    return { level: 2, reasons: { feats, fixes, breakings, deps: [] }, feats, fixes, breakings } // patch
                }
                return {}
            }
        }, function (err, result) {
            if (err) reject(err)
            else resolve(result as any)
        });
    });
    return result
}

function log(reason: CommitBase) {
    const head = reason.scope ? `**${reason.scope}**: ` : ''
    return `- ${head}${reason.subject} ([${reason.hash!}](${remote}/commit/${reason.hash!}))\n`
}

function renderChangelog(update: PackageUpdate, dedicated: boolean): string {
    const reasons = update.reasons
    if (reasons.breakings.length === 0
        && reasons.deps.length === 0
        && reasons.feats.length === 0
        && reasons.fixes.length === 0) {
        return ''
    }
    const padding = dedicated ? '###' : '####'

    let body = dedicated ? `## ${update.newVersion}\n` : `### ${update.packageJson.name}@${update.newVersion}\n`;
    if (reasons.breakings.length !== 0) {
        body += `${padding} BREAKING CHANGES\n\n`
        reasons.breakings.map(log).forEach(l => body += l);
    }
    if (reasons.feats.length !== 0) {
        body += `${padding} Features\n\n`
        reasons.feats.map(log).forEach(l => body += l);
    }
    if (reasons.fixes.length !== 0) {
        body += `${padding} Bug Fixes\n\n`
        reasons.fixes.map(log).forEach(l => body += l);
    }
    if (reasons.deps.length !== 0) {
        body += `${padding} Dependencies Updates\n\n`
        reasons.deps.map(d => `- Dependency ${d.name} bump **${d.releaseType}**\n`).forEach(l => body += l);
    }

    return body
}


async function readPackage(packageDir: string): Promise<PackageData> {
    const packageJsonPath = join(packageDir, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    return {
        packageDir,
        packageJson,
        packageJsonPath
    }
}

function getReleaseType(level: number) {
    switch (level) {
        case 0:
            return 'major'
        case 1:
            return 'minor'
        case 2:
            return 'patch'
    }
    return ''
}

async function calculatePackagesUpdate(packages: PackageData[]) {
    const updates: PackageUpdate[] = [];
    const visited: Record<string, Promise<PackageUpdate> | undefined> = {};


    async function calculateBump(pkg: PackageData): Promise<PackageUpdate> {
        const suggestion = await getBumpSuggestion(pkg.packageDir)
        const deps = pkg.packageJson.dependencies
        const depsUpdates: PackageUpdate[] = []
        if (deps) {
            for (const dep of Object.keys(deps)) {
                const localPackage = dict[dep]
                if (localPackage) {
                    depsUpdates.push(await getPackageBump(localPackage));
                }
            }
        }

        const bumpLevel = Math.min(suggestion.level ?? 3, depsUpdates.length > 0 ? 2 : 3)
        const releaseType = getReleaseType(bumpLevel)
        const newVersion = releaseType ? inc(pkg.packageJson.version, releaseType) : pkg.packageJson.version
        const reasons = suggestion.reasons ?? { deps: [], breakings: [], feats: [], fixes: [] }

        if (depsUpdates.length > 0) {
            for (const dep of depsUpdates) {
                reasons.deps.push({ name: dep.packageJson.name, releaseType: getReleaseType(dep.bumpLevel) })
            }
        }

        return {
            ...pkg,
            bumpLevel,
            newVersion,
            reasons,
        }
    }

    async function getPackageBump(pkg: PackageData): Promise<PackageUpdate> {
        const cached = visited[pkg.packageJson.name]
        if (cached) { return cached }

        const promise = calculateBump(pkg)

        visited[pkg.packageJson.name] = promise

        const update = await promise
        updates.push(update)
        return update
    }

    const dict: Record<string, PackageData> = {}
    for (const pack of packages) {
        dict[pack.packageJson.name] = pack
    }
    for (const pack of packages) {
        await getPackageBump(pack);
    }

    return updates;
}

async function updatePackageContent(update: PackageUpdate, changelogStartIndex: number) {
    await fs.promises.writeFile(update.packageJsonPath, JSON.stringify({ ...update.packageJson, version: update.newVersion }, null, 4));

    const changelogPath = join(update.packageDir, 'CHANGELOG.md')
    if (fs.existsSync(changelogPath)) {
        const changelog = await fs.promises.readFile(changelogPath, 'utf-8').catch(() => '')
        const changelogLines = changelog.split('\n')
        const newChangelog = renderChangelog(update, true)
        if (newChangelog) {
            const start = changelogStartIndex;
            const result = [...changelogLines.slice(0, start), ...newChangelog.split('\n'), ...changelogLines.slice(start)].join('\n');
            await fs.promises.writeFile(changelogPath, result);
        }
    }
}

async function main() {
    const packagesNames = getMultilineInput('packages', { required: false })
    const changelogStartIndex = Number.parseInt(getInput('changelog-start-at', { required: false }) || '0')
    const root = getInput('root', { required: false }) || process.cwd()
    // const changelogTarget = getBooleanInput('changelog-target', { required: false }) || 'all'

    const isMonorepo = packagesNames.length > 0

    const data =
        isMonorepo
            ? await Promise.all(packagesNames.map(pack => readPackage(pack)))
            : [await readPackage(root)]

    const updates = await calculatePackagesUpdate(data)

    for (const update of updates) {
        await updatePackageContent(update, changelogStartIndex)
    }

    if (isMonorepo) {
        const rootJsonPath = join(root, 'package.json')
        const rootPackageJson = JSON.parse(await fs.promises.readFile(rootJsonPath, 'utf-8'))
        const totalBumpLevel = Math.min(...updates.map(u => u.bumpLevel))
        const releaseType = getReleaseType(totalBumpLevel)
        const totalVersion = releaseType ? inc(rootPackageJson.version, releaseType) : rootPackageJson.version

        rootPackageJson.version = totalVersion
        await fs.promises.writeFile(rootJsonPath, JSON.stringify(rootPackageJson, null, 4))

        let body = `\n## ${totalVersion}\n`;
        for (const update of updates) {
            body += renderChangelog(update, false)
        }

        const changelogPath = join(root, 'CHANGELOG.md')
        if (fs.existsSync(changelogPath)) {
            const changelog = await fs.promises.readFile(changelogPath, 'utf-8')
            const changelogLines = changelog.split('\n')
            await fs.promises.writeFile(changelogPath, [...changelogLines.slice(0, changelogStartIndex), body, ...changelogLines.slice(changelogStartIndex)].join('\n'))
        }

        if (releaseType) {
            setOutput('release', true)
            setOutput('version', totalVersion)
            setOutput('changelog', body)
            return
        }
    } else {
        if (updates.length === 1) {
            setOutput('release', true)
            setOutput('version', updates[0].newVersion)
            setOutput('changelog', renderChangelog(updates[0], true))
            return
        }
    }
    setOutput('release', false)
    setOutput('version', '')
    setOutput('changelog', '')
}

main();
