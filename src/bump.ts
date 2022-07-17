import concat from 'concat-stream'
import conventionalCommitsFilter from 'conventional-commits-filter'
import conventionalCommitsParser from 'conventional-commits-parser'
import gitSemverTags from 'git-semver-tags'
import gitRawCommits from 'git-raw-commits'
import ConvBumpType from 'conventional-recommended-bump'


const VERSIONS = ['major', 'minor', 'patch']

const conventionalRecommendedBump: typeof ConvBumpType = (optionsArgument, parserOptsArgument, cbArgument) => {
    if (typeof optionsArgument !== 'object') {
        throw new Error('The \'options\' argument must be an object.')
    }

    const options = Object.assign({ ignoreReverted: true }, optionsArgument)

    const cb = typeof parserOptsArgument === 'function' ? parserOptsArgument : cbArgument

    if (typeof cb !== 'function') {
        throw new Error('You must provide a callback function.')
    }

    const whatBump = options.whatBump

    if (typeof whatBump !== 'function') {
        throw Error('whatBump must be a function')
    }

    // TODO: For now we defer to `config.recommendedBumpOpts.parserOpts` if it exists, as our initial refactor
    // efforts created a `parserOpts` object under the `recommendedBumpOpts` object in each preset package.
    // In the future we want to merge differences found in `recommendedBumpOpts.parserOpts` into the top-level
    // `parserOpts` object and remove `recommendedBumpOpts.parserOpts` from each preset package if it exists.
    const parserOpts = Object.assign({},
        parserOptsArgument)

    const warn = typeof parserOpts.warn === 'function' ? parserOpts.warn : noop

    gitSemverTags({
        lernaTags: !!options.lernaPackage,
        package: options.lernaPackage,
        tagPrefix: options.tagPrefix,
        skipUnstable: options.skipUnstable
    }, (err: any, tags: string[]) => {
        if (err) {
            return cb(err)
        }

        const useLegacy = false /* optionsArgument.isReleaseStage */
        const from = useLegacy ? tags[1] || '' : tags[0]
        const to = useLegacy ? tags[0] || '' : undefined

        console.log(`isReleaseStage: ${optionsArgument.isReleaseStage}`)
        console.log(`From ${from} to ${to}`)

        gitRawCommits({
            format: '%B%n-hash-%n%H',
            from,
            to,
            path: options.path
        })
            .pipe(conventionalCommitsParser(parserOpts))
            .pipe(concat(data => {
                const commits = options.ignoreReverted ? conventionalCommitsFilter(data) : data

                if (!commits || !commits.length) {
                    warn('No commits since last release')
                }

                let result = whatBump(commits, options)

                if (result && result.level != null) {
                    result.releaseType = VERSIONS[result.level]
                } else if (result == null) {
                    result = {}
                }

                cb(null, result)
            }))
    })
}

function noop() { }

export default conventionalRecommendedBump
