## Purpose

Lets the human overrule an arbiter ruling and counts the overrules. Moved from the Part 6 `delivery-report` spec.

## ADDED Requirements

### Requirement: The report holds the arbiter rulings
The report SHALL also hold the rulings and waivers, and the factory requests that arbiter follow-ups made.

#### Scenario: Factory follow-up
- **GIVEN** the arbiter made follow-up request `r-1-fu-1` with one low ticket, queued without the human
- **THEN** the report of `r-1` lists `r-1-fu-1`, its ticket and its status

### Requirement: The human can overrule a ruling
`POST /decisions/<id>/overrule` with a reason SHALL move an `applied` decision to `overruled`. Only the human SHALL call it. The report SHALL show the overrules, and the hub SHALL return the count of rulings and overrules for each room at `GET /rooms/<room>/arbiter-stats`.

#### Scenario: Overrule
- **WHEN** the human overrules a waiver with a reason
- **THEN** the decision is `overruled` and the stats count one overrule
