import { getInput, getMultilineInput, setOutput } from '@actions/core'
import { execSync } from 'child_process'
import convBump from 'conventional-recommended-bump'
import fs from 'fs'
import { join } from 'path'
import { inc } from 'semver'
import bump from './bump'

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
    refactors: CommitBase[]
    deps: { name: string; releaseType: string }[]
}

interface PackageUpdate extends PackageData {
    newVersion: string
    bumpLevel: number
    reasons: Reasons
}

const remote = execSync('git config --get remote.origin.url').toString().trim()

async function getBumpSuggestion(path: string, isReleaseStage: boolean) {
    const result = await new Promise<convBump.Callback.Recommendation & { reasons: Reasons }>((resolve, reject) => {
        bump({
            isReleaseStage,
            path,
            whatBump(comments) {
                const feats = comments.filter(c => c.type === 'feat')
                const fixes = comments.filter(c => c.type === 'fix' || c.type === 'patch')
                const refactors = comments.filter(c => c.type === 'refactor')
                const breakings = comments.filter(c => c.header?.startsWith('BREAKING CHANGE:'))
                if (comments.some(c => c.header?.startsWith('BREAKING CHANGE:'))) {
                    return { level: 0, reasons: { feats, fixes, breakings, deps: [] }, feats, fixes, breakings, refactors } // major
                } else if (comments.some(c => c.type === 'feat')) {
                    return { level: 1, reasons: { feats, fixes, breakings, deps: [] }, feats, fixes, breakings, refactors } // minor
                } else if (comments.some(c => c.type === 'fix' || c.type === 'refactor' || c.type === 'patch')) {
                    return { level: 2, reasons: { feats, fixes, breakings, deps: [] }, feats, fixes, breakings, refactors } // patch
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
        body += `${padding} 🛰️ BREAKING CHANGES\n\n`
        reasons.breakings.map(log).forEach(l => body += l);
    }
    if (reasons.feats.length !== 0) {
        body += `${padding} 🚀 Features\n\n`
        reasons.feats.map(log).forEach(l => body += l);
    }
    if (reasons.fixes.length !== 0) {
        body += `${padding} 🐛 Bug Fixes & Patches\n\n`
        reasons.fixes.map(log).forEach(l => body += l);
    }
    if (reasons.refactors.length !== 0) {
        body += `${padding} 🏗️ Refactors\n\n`
        reasons.refactors.map(log).forEach(l => body += l);
    }
    if (reasons.deps.length !== 0) {
        body += `${padding} 🔗 Dependencies Updates\n\n`
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

async function calculatePackagesUpdate(packages: PackageData[], isReleaseStage: boolean) {
    const updates: PackageUpdate[] = [];
    const visited: Record<string, Promise<PackageUpdate> | undefined> = {};


    async function calculateBump(pkg: PackageData): Promise<PackageUpdate> {
        const suggestion = await getBumpSuggestion(pkg.packageDir, isReleaseStage)
        const deps = pkg.packageJson.dependencies
        const depsUpdates: PackageUpdate[] = []
        if (deps) {
            for (const dep of Object.keys(deps)) {
                const localPackage = dict[dep]
                if (localPackage) {
                    const update = await getPackageBump(localPackage);
                    if (update.bumpLevel < 2) {
                        depsUpdates.push(update);
                    }
                }
            }
        }

        const bumpLevel = Math.min(suggestion.level ?? 3, depsUpdates.length > 0 ? 2 : 3)
        const releaseType = getReleaseType(isReleaseStage ? -1 : bumpLevel)
        const newVersion = releaseType ? inc(pkg.packageJson.version, releaseType) : pkg.packageJson.version
        const reasons = suggestion.reasons ?? { deps: [], breakings: [], feats: [], fixes: [], refactors: [] }

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
    const stage = getInput('stage', { required: true })
    const isReleaseStage = stage === 'release'

    const data = await Promise.all(packagesNames.map(pack => readPackage(pack)))

    const updates = await calculatePackagesUpdate(data, isReleaseStage)

    if (!isReleaseStage) {
        for (const update of updates) {
            await updatePackageContent(update, changelogStartIndex)
        }
    }

    const rootPkg = await readPackage(root)
    const rootUpdate = (await calculatePackagesUpdate([rootPkg], isReleaseStage))[0]
    const rootJsonPath = join(root, 'package.json')
    const rootPackageJson = JSON.parse(await fs.promises.readFile(rootJsonPath, 'utf-8'))
    const totalBumpLevel = Math.min(...updates.map(u => u.bumpLevel))
    const releaseType = getReleaseType(isReleaseStage ? -1 : totalBumpLevel)
    const totalVersion = releaseType ? inc(rootPackageJson.version, releaseType) : rootPackageJson.version

    rootPackageJson.version = totalVersion
    if (!isReleaseStage) {
        await fs.promises.writeFile(rootJsonPath, JSON.stringify(rootPackageJson, null, 4))
    }

    let body = renderChangelog(rootUpdate, true)

    setOutput('release', isReleaseStage || !!releaseType)
    setOutput('version', totalVersion)
    setOutput('tag', `v${totalVersion}`)
    setOutput('changelog', body)
}

main();
