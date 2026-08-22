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

GitHub private vulnerability reporting is **not currently enabled** for [Software-Land/search](https://github.com/Software-Land/search), and this repository does not publish a private contact address.

A private intake path cannot be advertised until maintainers either:

1. enable [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on `Software-Land/search`, or
2. document another private channel.

Until one of those exists, do not file public issues for vulnerabilities.
