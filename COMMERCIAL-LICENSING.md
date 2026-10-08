# Commercial licensing

This document explains Software.Land’s public commercial licensing policy for
`@software-land/search`. It is not a commercial license agreement. It does not
itself grant commercial production rights, and it does not automatically impose
a royalty. When production use requires commercial rights, a separate agreement
with Software.Land supplies those rights, unless that version’s Change License
has already taken effect.

## Business Source License 1.1

`@software-land/search` 0.5.0 and later are source-available under the
[Business Source License 1.1](LICENSE) (SPDX: `BUSL-1.1`).

For source revisions and future releases carrying the revised
[LICENSE](LICENSE):

- Non-production use is free under the standard BSL 1.1 grant.
- Production use is permitted without a commercial license when the
  consolidated annual gross revenue of you and your Affiliates for the most
  recently completed fiscal year is less than USD $100,000.
- At exactly USD $100,000, production use is outside that Additional Use Grant.
  A separate commercial agreement is required, even though the marginal pricing
  formula below produces a $0 annual fee.
- Change Date: 2030-08-28.
- Change License: Apache License, Version 2.0.

The free-production condition is strictly less than USD $100,000.

Affiliate and consolidation semantics are defined in [LICENSE](LICENSE): the
threshold applies to you together with entities that control, are controlled
by, or are under common control with you.

## Prospective application and earlier grants

The reduced free-production threshold applies prospectively to source revisions
and future releases carrying the revised [LICENSE](LICENSE).

Earlier distributions retain their accompanying license grants. Where an
earlier distribution’s Additional Use Grant permitted free production use at
consolidated annual gross revenue less than USD $10,000,000, that grant
continues to govern that distribution. This policy does not rewrite or
replace those grants.

`@software-land/search` versions through and including 0.4.0 remain licensed
under Apache License 2.0. Those grants are not revoked, altered, or
retroactively replaced by the Business Source License or by this threshold
change.

## Change License

Each BSL 1.1 version of `@software-land/search` eventually becomes available
under its Change License (Apache License, Version 2.0) according to BSL 1.1:
on the earlier of that version’s Change Date or the fourth anniversary of
first public distribution of that version under BSL. See [LICENSE](LICENSE).
Future versions may set different license parameters prospectively.

## Standard public pricing for new quotes

This schedule is Software.Land’s standard public pricing policy for new
commercial license quotes. It is not part of the BSL Additional Use Grant.
[LICENSE](LICENSE) determines whether production use requires a commercial
agreement. This schedule is the standard price for a new quote once that
agreement is required.

Using the software does not by itself create an automatic royalty. Commercial
rights, when required, come from a separate agreement with Software.Land,
unless that version’s Change License has already taken effect.

Existing agreements continue to govern their own pricing, renewals, and other
terms.

The measured amount is the same consolidated annual gross revenue used by the
Additional Use Grant: you and your Affiliates, for the most recently completed
fiscal year. There is no minimum fee, no cap, and no allocation limited to
revenue from products using the software.

### Marginal rates

Each percentage applies only to the revenue inside its band. Do not apply the
highest applicable band’s percentage to all revenue.

| Portion of consolidated annual gross revenue (USD) | Annual marginal rate |
| --- | ---: |
| First $100,000 | 0% |
| Above $100,000 up to $1,000,000 | 0.05% |
| Above $1,000,000 up to $10,000,000 | 0.02% |
| Above $10,000,000 up to $100,000,000 | 0.01% |
| Above $100,000,000 up to $1,000,000,000 | 0.005% |
| Above $1,000,000,000 up to $10,000,000,000 | 0.002% |
| Above $10,000,000,000 up to $100,000,000,000 | 0.001% |
| Above $100,000,000,000 up to $1,000,000,000,000 | 0.0005% |
| Above $1,000,000,000,000 ($1T+ tier) | 0.0001% |

A stated percentage converts to the decimal rate in the formula by dividing by
100:

| Stated rate | Decimal rate |
| --- | ---: |
| 0% | 0 |
| 0.05% | 0.0005 |
| 0.02% | 0.0002 |
| 0.01% | 0.0001 |
| 0.005% | 0.00005 |
| 0.002% | 0.00002 |
| 0.001% | 0.00001 |
| 0.0005% | 0.000005 |
| 0.0001% | 0.000001 |

### Calculation

For annual revenue `R`, each bounded band contributes:

`max(0, min(R, upper_bound) - lower_bound) × decimal_rate`

The final band contributes:

`max(0, R - 1,000,000,000,000) × 0.000001`

The commas in `1,000,000,000,000` are thousands separators. That bound is one
trillion US dollars, and `0.000001` is the decimal form of 0.0001%.

Bounded bands use these bounds. The first lower bound is 0. Each following
lower bound equals the previous upper bound. Revenue equal to a boundary is
included only in the earlier band, and the next band starts above that
boundary, so the bands have no gap and no overlap.

| Portion | lower_bound | upper_bound | decimal_rate |
| --- | ---: | ---: | ---: |
| First $100,000 | 0 | 100,000 | 0 |
| Above $100,000 up to $1,000,000 | 100,000 | 1,000,000 | 0.0005 |
| Above $1,000,000 up to $10,000,000 | 1,000,000 | 10,000,000 | 0.0002 |
| Above $10,000,000 up to $100,000,000 | 10,000,000 | 100,000,000 | 0.0001 |
| Above $100,000,000 up to $1,000,000,000 | 100,000,000 | 1,000,000,000 | 0.00005 |
| Above $1,000,000,000 up to $10,000,000,000 | 1,000,000,000 | 10,000,000,000 | 0.00002 |
| Above $10,000,000,000 up to $100,000,000,000 | 10,000,000,000 | 100,000,000,000 | 0.00001 |
| Above $100,000,000,000 up to $1,000,000,000,000 | 100,000,000,000 | 1,000,000,000,000 | 0.000005 |

The $1T+ tier has lower bound 1,000,000,000,000, no upper bound, and decimal
rate 0.000001.

Sum every band contribution, then round that final total to the nearest US
cent. A remainder of exactly half a cent rounds up.

Every marginal rate is zero or positive, so higher revenue never reduces the
total fee. Crossing a band boundary does not reprice revenue in earlier bands.
Only the revenue inside the newly entered band uses that band’s rate.

### Worked example: USD $2,000,000

- The first $100,000 at 0% contributes $0.
- The next $900,000 at 0.05% contributes $450.
- The remaining $1,000,000 at 0.02% contributes $200.
- The annual total is $650.

### Examples

These annual prices are the rounded results of the calculation above. The
USD $100,000 row is a $0 formula result. Production use at that revenue still
requires a separate commercial agreement, because the Additional Use Grant
covers production use only below USD $100,000.

| Consolidated annual revenue | Annual license price |
| --- | ---: |
| $100,000 | $0 |
| $500,000 | $200 |
| $1,000,000 | $450 |
| $2,000,000 | $650 |
| $10,000,000 | $2,250 |
| $100,000,000 | $11,250 |
| $1,000,000,000 | $56,250 |
| $10,000,000,000 | $236,250 |
| $100,000,000,000 | $1,136,250 |
| $1,000,000,000,000 | $5,636,250 |
| $2,000,000,000,000 | $6,636,250 |

## Obtaining a commercial license

Contact Software.Land to obtain a commercial license. Terms are provided under
a separate commercial agreement.
