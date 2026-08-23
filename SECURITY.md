# Security Policy

Do not file security vulnerabilities as public GitHub issues.

This project is pre-1.0. The latest published 0.x release of `@software-land/search` is the supported security line unless a later note in this file or the changelog says otherwise. Older 0.x releases may not receive backports.

## Scope

Reports should cover:

- the Node runtime (`@software-land/search`)
- the browser Worker / public package
- build-time compilers and tooling (`./corpus`, `./relationships`, `./semantic`, `./lexical`)
- package distribution
- generated artifact handling

Runtime search is model-free. Optional embedding weights used by the Python semantic compiler are downloaded into a builder cache and are not shipped in the npm tarball; they are still in scope if a compiler or cache-handling bug affects consumers.

## Reporting

Please report security vulnerabilities privately through
[GitHub Private Vulnerability Reporting](https://github.com/Software-Land/search/security/advisories/new).

Do not file security vulnerabilities as public GitHub issues.
