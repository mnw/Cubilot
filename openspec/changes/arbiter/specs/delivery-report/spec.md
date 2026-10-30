## Purpose

Lets the human overrule an arbiter ruling and counts the overrules. Moved from the Part 6 `delivery-report` spec.

## ADDED Requirements

### Requirement: The human can overrule a ruling
`POST /decisions/<id>/overrule` with a reason SHALL move an `applied` decision to `overruled`. Only the human SHALL call it. The report SHALL show the overrules, and the hub SHALL return the count of rulings and overrules for each room at `GET /rooms/<room>/arbiter-stats`.

#### Scenario: Overrule
- **WHEN** the human overrules a waiver with a reason
- **THEN** the decision is `overruled` and the stats count one overrule
