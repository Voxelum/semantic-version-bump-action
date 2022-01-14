# The bump version & create changelog actions

This action will try to bump version in package.json by the git commit.

It use the `conventional-recommended-bump` to decide what version should be bumped.

It will simply collect the commit message and generate changelog.

It will write to the CHANGELOG.md if it present beside the `package.json`

## Pre-requirement

Must have a `package.json` file in the root directory with the `version` field.

You can set the root via the input property `root`.

## Input

### root

The root of nodejs project. By default this is `.`.

### packages

If your project is a monorepo, you can assign the sub-packages in this list. It does not support blob yet, but I might add it in the future.

### changelog-start-at

When we generate the changelog, we will try to incrementally insert the new changelog to the beginning of the `CHANGELOG.md`. This can change the line to insert. By default, this is `0`.


## Output

### release

A boolean value represent should this change create a new release.
If no `fix`, `feat`, `BREAKING CHANGE` present. This will be `false`.

### version

The new version of the root project `package.json`.

### changelog

The changelog text of the root project `package.json`.
